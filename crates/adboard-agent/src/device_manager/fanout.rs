//! Run one operation on many phones at once.
//!
//! Controlling several phones used to wait for each in turn, so a nav key or a
//! shell command took (number of phones) x (one adb round trip). These
//! helpers run the phones side by side while keeping two guarantees:
//! results come back in request order, and one phone that fails or hangs
//! only ever delays itself (each adb call has its own time limit).

use super::*;
use futures_util::future::join_all;
use futures_util::stream::{self, StreamExt};
use std::future::Future;

/// Phones worked on at once for input and commands.
pub const DEFAULT_LIMIT: usize = 8;
/// Installs and pushes move whole files over USB, so fewer at a time.
pub const TRANSFER_LIMIT: usize = 4;

/// Apply `op` to every item with at most `limit` running at once. The output
/// has one entry per item, in the same order as `items`.
pub async fn fan_out<T, R, F, Fut>(items: Vec<T>, limit: usize, op: F) -> Vec<R>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = R>,
{
    stream::iter(items)
        .map(op)
        .buffered(limit.max(1))
        .collect()
        .await
}

/// Send each remote host its phones at the same time. A host that cannot be
/// reached yields `on_error` for every one of its phones.
pub async fn fan_out_remote<R, P, Fut, E>(
    by_remote: HashMap<String, Vec<Device>>,
    proxy: P,
    on_error: E,
) -> Vec<R>
where
    P: Fn(String, Vec<Device>) -> Fut,
    Fut: Future<Output = Result<Vec<R>, String>>,
    E: Fn(&Device, &str) -> R,
{
    let on_error = &on_error;
    let runs = by_remote.into_iter().map(|(host_id, group)| {
        let call = proxy(host_id, group.clone());
        async move {
            match call.await {
                Ok(results) => results,
                Err(error) => group.iter().map(|d| on_error(d, &error)).collect(),
            }
        }
    });
    join_all(runs).await.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn results_keep_request_order_even_when_later_items_finish_first() {
        let out = fan_out(vec![3u64, 1, 2, 0], 8, |n| async move {
            tokio::time::sleep(Duration::from_millis(n * 30)).await;
            n
        })
        .await;
        assert_eq!(out, vec![3, 1, 2, 0]);
    }

    #[tokio::test]
    async fn items_run_side_by_side() {
        let started = Instant::now();
        let out = fan_out(vec![0u32; 6], 8, |_| async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            1u32
        })
        .await;
        assert_eq!(out.len(), 6);
        assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn the_limit_caps_how_many_run_at_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let live = std::sync::Arc::new(AtomicUsize::new(0));
        let peak = std::sync::Arc::new(AtomicUsize::new(0));
        let (l, p) = (live.clone(), peak.clone());
        fan_out(vec![0u32; 10], 3, move |_| {
            let (l, p) = (l.clone(), p.clone());
            async move {
                let now = l.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                l.fetch_sub(1, Ordering::SeqCst);
            }
        })
        .await;
        assert_eq!(peak.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn an_empty_list_and_a_zero_limit_are_fine() {
        let none: Vec<u32> = fan_out(Vec::<u32>::new(), 0, |n| async move { n }).await;
        assert!(none.is_empty());
        assert_eq!(fan_out(vec![1u32, 2], 0, |n| async move { n }).await, vec![1, 2]);
    }
}
