//! Cron expressions for macro schedules (port of `src/lib/macro/cron.ts`).
//!
//! Five fields — minute, hour, day of month, month, day of week — with `*`,
//! lists (`1,15`), ranges (`1-5`), steps (`*/15`, `8-18/2`), month and day
//! names (`jan`, `mon-fri`) and the shortcuts `@hourly`, `@daily`,
//! `@weekly`, `@monthly`, `@yearly`. Day of week is 0–7 (0 and 7 are
//! Sunday). As in classic cron, when both day fields are restricted a day
//! matches if either does (`0 9 1 * mon` = the 1st and every Monday).
//!
//! Times are wall-clock times on the ADBoard computer: `0 8 * * *` is 08:00
//! local time, before and after a daylight-saving change. A time skipped by
//! the change (02:30 on a spring-forward night) does not run; a time that
//! happens twice runs once.

use chrono::{Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: u64,
    hours: u32,
    /// Bits 1–31.
    days: u32,
    /// Bits 1–12.
    months: u16,
    /// Bits 0–6, Sunday = 0.
    weekdays: u8,
    any_day: bool,
    any_weekday: bool,
}

const MONTHS: &[&str] = &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/// No match within this many years: the expression never fires (e.g. 31 feb).
const SEARCH_YEARS: i32 = 5;

struct Field {
    name: &'static str,
    min: u32,
    max: u32,
    names: &'static [&'static str],
    /// First name's value (jan = 1, sun = 0).
    names_from: u32,
}

const FIELDS: [Field; 5] = [
    Field { name: "Minute", min: 0, max: 59, names: &[], names_from: 0 },
    Field { name: "Hour", min: 0, max: 23, names: &[], names_from: 0 },
    Field { name: "Day of month", min: 1, max: 31, names: &[], names_from: 0 },
    Field { name: "Month", min: 1, max: 12, names: MONTHS, names_from: 1 },
    Field { name: "Day of week", min: 0, max: 7, names: WEEKDAYS, names_from: 0 },
];

fn value(field: &Field, text: &str) -> Result<u32, String> {
    let lower = text.to_ascii_lowercase();
    if let Some(at) = field.names.iter().position(|n| *n == lower) {
        return Ok(at as u32 + field.names_from);
    }
    let n: u32 = text.parse().map_err(|_| format!("{}: “{text}” is not a number", field.name))?;
    if n < field.min || n > field.max {
        return Err(format!("{}: {n} is out of range ({}–{})", field.name, field.min, field.max));
    }
    Ok(n)
}

/// One field → bitmask of the values it allows, and whether it was `*`.
fn parse_field(field: &Field, text: &str) -> Result<(u64, bool), String> {
    let mut mask = 0u64;
    let any = text == "*";
    for part in text.split(',') {
        if part.is_empty() {
            return Err(format!("{}: empty item in “{text}”", field.name));
        }
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step.parse().map_err(|_| format!("{}: step “{step}” is not a number", field.name))?;
                if step == 0 {
                    return Err(format!("{}: a step of 0 never repeats", field.name));
                }
                (range, step)
            }
            None => (part, 1),
        };
        let (from, to) = if range == "*" {
            (field.min, field.max)
        } else if let Some((a, b)) = range.split_once('-') {
            let (a, b) = (value(field, a)?, value(field, b)?);
            if a > b {
                return Err(format!("{}: range {a}-{b} goes backwards", field.name));
            }
            (a, b)
        } else {
            let a = value(field, range)?;
            // `5/10` means from 5 to the end, every 10.
            (a, if part.contains('/') { field.max } else { a })
        };
        let mut v = from;
        while v <= to {
            mask |= 1 << v;
            v += step;
        }
    }
    Ok((mask, any))
}

pub fn parse(expression: &str) -> Result<Cron, String> {
    let text = expression.trim();
    let expanded = match text.to_ascii_lowercase().as_str() {
        "@yearly" | "@annually" => "0 0 1 1 *".to_string(),
        "@monthly" => "0 0 1 * *".into(),
        "@weekly" => "0 0 * * 0".into(),
        "@daily" | "@midnight" => "0 0 * * *".into(),
        "@hourly" => "0 * * * *".into(),
        _ if text.starts_with('@') => return Err(format!("Unknown shortcut “{text}”")),
        _ => text.to_string(),
    };
    let parts: Vec<&str> = expanded.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(format!("A cron expression has 5 fields (minute hour day month weekday); this one has {}", parts.len()));
    }
    let mut masks = [0u64; 5];
    let mut any = [false; 5];
    for (i, part) in parts.iter().enumerate() {
        let (mask, star) = parse_field(&FIELDS[i], part)?;
        masks[i] = mask;
        any[i] = star;
    }
    // Sunday is 0 or 7.
    let weekdays = ((masks[4] & 0x7f) | ((masks[4] >> 7) & 1)) as u8;
    Ok(Cron {
        minutes: masks[0],
        hours: masks[1] as u32,
        days: masks[2] as u32,
        months: masks[3] as u16,
        weekdays,
        any_day: any[2],
        any_weekday: any[4],
    })
}

impl Cron {
    fn day_matches(&self, date: NaiveDate) -> bool {
        let dom = self.days & (1 << date.day()) != 0;
        let dow = self.weekdays & (1 << date.weekday().num_days_from_sunday()) != 0;
        match (self.any_day, self.any_weekday) {
            (false, false) => dom || dow,
            _ => dom && dow,
        }
    }

    /// First matching wall-clock minute strictly after `after` (naive local time).
    fn next_naive(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let mut t = after.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1);
        let limit = after.year() + SEARCH_YEARS;
        while t.year() <= limit {
            if self.months & (1 << t.month()) == 0 {
                let (y, m) = if t.month() == 12 { (t.year() + 1, 1) } else { (t.year(), t.month() + 1) };
                t = NaiveDate::from_ymd_opt(y, m, 1)?.and_hms_opt(0, 0, 0)?;
                continue;
            }
            if !self.day_matches(t.date()) {
                t = (t.date() + Duration::days(1)).and_hms_opt(0, 0, 0)?;
                continue;
            }
            if self.hours & (1 << t.hour()) == 0 {
                t = t.with_minute(0)? + Duration::hours(1);
                continue;
            }
            if self.minutes & (1 << t.minute()) == 0 {
                t += Duration::minutes(1);
                continue;
            }
            return Some(t);
        }
        None
    }

    /// The next run strictly after `after`, in `tz`.
    pub fn next_after<Tz: TimeZone>(&self, after: &chrono::DateTime<Tz>) -> Option<chrono::DateTime<Tz>> {
        let tz = after.timezone();
        let mut naive = after.naive_local();
        for _ in 0..1000 {
            let candidate = self.next_naive(naive)?;
            match tz.from_local_datetime(&candidate) {
                LocalResult::Single(t) if t > *after => return Some(t),
                // Clocks went back: the hour happens twice; run at the first only.
                LocalResult::Ambiguous(first, _) if first > *after => return Some(first),
                // Skipped by clocks going forward, or not after `after`.
                _ => {}
            }
            naive = candidate;
        }
        None
    }
}

/// Next run (ms) strictly after `after_ms`, in the ADBoard computer's time zone.
pub fn next_local(cron: &Cron, after_ms: u64) -> Option<u64> {
    let after = chrono::Local.timestamp_millis_opt(after_ms as i64).single()?;
    cron.next_after(&after).map(|t| t.timestamp_millis().max(0) as u64)
}

/// The ADBoard computer's offset from UTC right now, in minutes.
pub fn local_offset_minutes() -> i32 {
    chrono::Local::now().offset().local_minus_utc() / 60
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Utc};

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn next(expr: &str, from: chrono::DateTime<Utc>) -> chrono::DateTime<Utc> {
        parse(expr).unwrap().next_after(&from).unwrap()
    }

    #[test]
    fn common_schedules() {
        // Sat 2026-10-24 10:07 UTC.
        let now = at(2026, 10, 24, 10, 7);
        assert_eq!(next("*/15 * * * *", now), at(2026, 10, 24, 10, 15));
        assert_eq!(next("0 * * * *", now), at(2026, 10, 24, 11, 0));
        assert_eq!(next("0 8 * * *", now), at(2026, 10, 25, 8, 0));
        assert_eq!(next("0 8 * * 1-5", now), at(2026, 10, 26, 8, 0), "weekdays: Monday");
        assert_eq!(next("30 9 * * MON,thu", now), at(2026, 10, 26, 9, 30));
        assert_eq!(next("0 0 1 * *", now), at(2026, 11, 1, 0, 0));
        assert_eq!(next("@yearly", now), at(2027, 1, 1, 0, 0));
        assert_eq!(next("@weekly", now), at(2026, 10, 25, 0, 0), "Sunday");
        assert_eq!(next("0 12 * * 7", now), at(2026, 10, 25, 12, 0), "7 is Sunday too");
        assert_eq!(next("0 8-18/2 * * *", now), at(2026, 10, 24, 12, 0));
        assert_eq!(next("5/20 * * * *", now), at(2026, 10, 24, 10, 25));
        assert_eq!(next("0 0 29 feb *", now), at(2028, 2, 29, 0, 0), "next leap day");
        // Strictly after: the current minute is not "next".
        assert_eq!(next("7 10 * * *", now), at(2026, 10, 25, 10, 7));
    }

    #[test]
    fn day_of_month_or_day_of_week() {
        // Both restricted: the 1st OR any Monday.
        let now = at(2026, 10, 24, 10, 0);
        assert_eq!(next("0 9 1 * mon", now), at(2026, 10, 26, 9, 0));
        assert_eq!(next("0 9 1 * mon", at(2026, 10, 27, 0, 0)), at(2026, 11, 1, 9, 0));
        // Only one restricted: just that one.
        assert_eq!(next("0 9 1 * *", now), at(2026, 11, 1, 9, 0));
    }

    #[test]
    fn bad_expressions_say_why() {
        for (expr, says) in [
            ("* * * *", "5 fields"),
            ("60 * * * *", "Minute: 60 is out of range"),
            ("* 24 * * *", "Hour"),
            ("* * 0 * *", "Day of month"),
            ("* * * 13 *", "Month"),
            ("* * * * 8", "Day of week"),
            ("*/0 * * * *", "step of 0"),
            ("5-1 * * * *", "backwards"),
            ("x * * * *", "not a number"),
            ("1,,2 * * * *", "empty item"),
            ("@often", "Unknown shortcut"),
        ] {
            let error = parse(expr).unwrap_err();
            assert!(error.contains(says), "{expr}: {error}");
        }
        assert!(parse("0 0 31 2 *").unwrap().next_after(&at(2026, 1, 1, 0, 0)).is_none(), "never");
    }

    /// Daylight saving with the system time zone database (Linux).
    #[cfg(unix)]
    #[test]
    fn daylight_saving_skips_and_repeats_like_the_browser() {
        std::env::set_var("TZ", "Europe/Berlin");
        let local = |y, mo, d, h, mi| chrono::Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap();
        if local(2026, 7, 1, 12, 0).offset().local_minus_utc() == local(2026, 1, 1, 12, 0).offset().local_minus_utc() {
            eprintln!("skipped: no time zone database");
            return;
        }
        let cron = parse("30 2 * * *").unwrap();
        // 29 March 2026: 02:00 → 03:00; 02:30 does not exist that night.
        assert_eq!(cron.next_after(&local(2026, 3, 28, 12, 0)).unwrap(), local(2026, 3, 30, 2, 30));
        // 25 October 2026: 03:00 → 02:00; 02:30 happens twice, runs once.
        let first = cron.next_after(&local(2026, 10, 24, 12, 0)).unwrap();
        assert_eq!(first.naive_local(), local(2026, 10, 25, 2, 30).naive_local());
        assert_eq!(cron.next_after(&first).unwrap(), local(2026, 10, 26, 2, 30));
        // 08:00 stays 08:00 local across the change.
        assert_eq!(parse("0 8 * * *").unwrap().next_after(&local(2026, 3, 28, 12, 0)).unwrap(), local(2026, 3, 29, 8, 0));
    }

    #[test]
    fn times_are_wall_clock_in_the_zone() {
        // UTC+2: 08:00 local is 06:00 UTC.
        let zone = FixedOffset::east_opt(2 * 3600).unwrap();
        let now = zone.with_ymd_and_hms(2026, 10, 24, 7, 0, 0).unwrap();
        let fired = parse("0 8 * * *").unwrap().next_after(&now).unwrap();
        assert_eq!(fired.with_timezone(&Utc), at(2026, 10, 24, 6, 0));
        assert!(next_local(&parse("* * * * *").unwrap(), 0).is_some());
    }
}
