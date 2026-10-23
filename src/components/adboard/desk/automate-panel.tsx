"use client";

import { useEffect, useMemo, useState } from "react";
import { readUiState, writeUiState } from "@/lib/ui-state";
import { exportShellScript, mergeShellLibrary, parseShellImport, shellFileName, uniqueName } from "@/lib/adboard-files";
import { saveTextFile } from "@/lib/api/download";
import { exportWholeLibrary } from "@/lib/library";
import { FolderHint } from "@/components/adboard/desk/data-storage";
import { ACTIONS, CATEGORIES, newStep } from "@/lib/desk/actions";
import {
  emptyProfile,
  newId,
  parseDeskExport,
  updateLibrary,
  useLibrary,
  type DeviceProfile,
  type MacroStepKind,
  type SavedMacro,
} from "@/lib/desk/store";
import { useDesk } from "@/components/adboard/desk/desk-context";
import {
  ConfirmDialog,
  EmptyState,
  PanelFrame,
  PrimaryButton,
  TargetChecks,
  TextField,
  useChecked,
} from "@/components/adboard/desk/bits";
import { MechanismBadge, ShellBuilder } from "@/components/adboard/desk/shell-builder";

/** Tabs in the order you use them, each with a one-line hint and a plain explanation. */
const TABS = [
  {
    id: "library",
    label: "Library",
    sub: "Saved jobs",
    explain: "Your saved jobs, and every action a job can use, grouped by what it does. Add an action to send it to the Builder.",
  },
  {
    id: "builder",
    label: "Builder",
    sub: "Make a job",
    explain:
      "Build a job step by step next to the phone's live screen: touch steps show where they land. Test one step, or run the whole job on the phones you tick. Example: Force stop game → Launch game → Wait 10 s → Tap Start.",
  },
  {
    id: "variables",
    label: "Variables",
    sub: "Per-phone values",
    explain:
      "Write ${NAME} in a step and it becomes this value when it runs: one value for every phone, or a different one per phone. Example: ${USERNAME} = farm01 on S24, farm02 on S23.",
  },
  {
    id: "groups",
    label: "Groups",
    sub: "Phone sets",
    explain: "Saved sets of phones. They also appear in the Devices sidebar to select many phones in one tap.",
  },
  {
    id: "profiles",
    label: "Profiles",
    sub: "Per-phone settings",
    explain: "Per-phone settings for Automation jobs: which jobs belong to this phone, and tags to sort phones.",
  },
  {
    id: "history",
    label: "History",
    sub: "Past runs",
    explain: "The last 30 Automation runs and how each phone did.",
  },
] as const;

const VIEW_KEY = "adboard-automate-view";

export function AutomatePanel() {
  const library = useLibrary();
  const desk = useDesk();
  // The open tab and job are remembered (builder_state.json) across reloads.
  const [saved] = useState(() => readUiState<{ tab: string; jobId: string | null }>(VIEW_KEY, { tab: "library", jobId: null }));
  const [tab, setTab] = useState(desk.focusTool || saved.tab);
  const [macroId, setMacroId] = useState<string | null>(
    library.macros.some((m) => m.id === saved.jobId) ? saved.jobId : (library.macros[0]?.id ?? null),
  );
  useEffect(() => writeUiState(VIEW_KEY, { tab, jobId: macroId }), [tab, macroId]);
  const [focusStepId, setFocusStepId] = useState<string | null>(null);
  const macro = library.macros.find((item) => item.id === macroId) ?? null;

  /** Library → Builder: put the action in the open job (a new job if none). */
  const addAction = (kind: MacroStepKind) => {
    const step = newStep(kind);
    if (macro) {
      updateLibrary((current) => ({
        ...current,
        macros: current.macros.map((m) => (m.id === macro.id ? { ...m, steps: [...m.steps, step] } : m)),
      }));
    } else {
      const created: SavedMacro = { id: newId("macro"), name: "New job", folder: "Custom", steps: [step] };
      updateLibrary((current) => ({ ...current, macros: [...current.macros, created] }));
      setMacroId(created.id);
    }
    setFocusStepId(step.id);
    setTab("builder");
  };

  return (
    <PanelFrame title="Shell Automation" panel="automate">
      <p className="text-sm text-[var(--pc-muted)]">
        Shell Automation runs app, file and shell-command jobs on many phones. Finger-touch macros live in Macros.
      </p>
      <div className="flex flex-wrap gap-2" data-automate-tabs>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            className={`flex min-h-11 flex-col items-start justify-center rounded-lg px-3 py-1 text-left ${tab === item.id ? "bg-[var(--pc-accent-fill)] text-white" : "border border-[var(--pc-line)]"}`}
            onClick={() => setTab(item.id)}
            data-automate-tab={item.id}
          >
            <span className="text-sm leading-tight">{item.label}</span>
            <span className={`text-[11px] leading-tight ${tab === item.id ? "text-white/80" : "text-[var(--pc-muted)]"}`}>{item.sub}</span>
          </button>
        ))}
      </div>
      {TABS.find((item) => item.id === tab) && (
        <p className="text-xs text-[var(--pc-muted)]" data-automate-explain>
          {TABS.find((item) => item.id === tab)!.explain}
        </p>
      )}
      {tab === "library" && (
        <JobLibrary
          openId={macro?.id ?? null}
          onOpen={(id) => {
            setMacroId(id);
            setFocusStepId(null);
            setTab("builder");
          }}
          onAddAction={addAction}
        />
      )}
      {tab === "builder" && (
        <ShellBuilder
          macro={macro}
          focusStepId={focusStepId}
          onCreate={(created) => {
            setMacroId(created.id);
            setFocusStepId(null);
          }}
        />
      )}
      {tab === "variables" && <VariablesEditor />}
      {tab === "groups" && <GroupsEditor />}
      {tab === "profiles" && <ProfilesEditor />}
      {tab === "history" && <HistoryList />}
    </PanelFrame>
  );
}

/** Check a single exported job before adding it. */
/**
 * Shell Automation → Import: an ADBoard script file, one raw job, an older
 * PhoneControl desk export or adboard-library.json, told apart by contents.
 * Everything is added to the library (never replaced); items already here
 * are skipped and name clashes get " 2".
 */
function importShellFile(text: string): string {
  const read = parseShellImport(text);
  const incoming = read.kind === "scripts" ? { macros: read.scripts } : read.library;
  // Same checks as the agent and older imports: step kinds, arrays, objects.
  const checked = parseDeskExport(JSON.stringify({ ...incoming, macros: incoming.macros ?? [] }));
  let summary = "";
  updateLibrary((current) => {
    const merged = mergeShellLibrary(current, read.kind === "scripts" ? { macros: checked.macros } : checked, newId);
    const c = merged.scripts;
    const what = read.kind === "scripts" && read.scripts.length === 1 ? `“${read.scripts[0].name}”` : `${c.added} script${c.added === 1 ? "" : "s"}`;
    summary =
      c.added === 0
        ? "Nothing new: every script in the file is already in the library."
        : `Imported ${what}${c.renamed ? ` (${c.renamed} renamed to avoid a duplicate name)` : ""}${c.skipped ? `; ${c.skipped} already here` : ""}.`;
    return merged.library;
  });
  return summary;
}

function JobLibrary({
  openId,
  onOpen,
  onAddAction,
}: {
  openId: string | null;
  onOpen: (id: string | null) => void;
  onAddAction: (kind: MacroStepKind) => void;
}) {
  const library = useLibrary();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedMacro | null>(null);
  const open = library.macros.find((m) => m.id === openId) ?? null;
  // Only folders that hold jobs: empty placeholder folders are not shown.
  const folders = useMemo(() => {
    const names: string[] = [];
    for (const macro of library.macros) {
      const name = macro.folder || "Custom";
      if (!names.includes(name)) names.push(name);
    }
    return names;
  }, [library.macros]);

  const importInput = (label: string, attr: string, onText: (text: string) => void) => (
    <label className="pc-toggle pc-toggle-sm cursor-pointer" {...{ [attr]: true }}>
      {label}
      <input
        type="file"
        accept="application/json,.json"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void file.text().then((text) => {
            try {
              onText(text);
            } catch (error) {
              setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not import the file" });
            }
          });
        }}
      />
    </label>
  );

  return (
    <div className="@container flex min-w-0 flex-col gap-4" data-shell-library>
      <section className="flex flex-col gap-2" data-shell-jobs>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Saved jobs ({library.macros.length})</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="pc-toggle pc-toggle-sm" onClick={() => onOpen(null)} data-shell-new-job>
              New job
            </button>
            {importInput("Import", "data-shell-import", (text) => setNotice({ tone: "ok", text: importShellFile(text) }))}
            <button
              type="button"
              className="pc-toggle pc-toggle-sm"
              title="Everything: touch macros, Shell Automation, queue and schedules"
              onClick={() => void exportWholeLibrary()}
              data-shell-export-library
            >
              Export library
            </button>
          </div>
        </div>
        <FolderHint folder="shell_scripts" store="desk" itemId={openId} />
        {notice && (
          <p role="status" className={notice.tone === "error" ? "text-xs text-[var(--pc-warn)]" : "text-xs text-[var(--pc-signal)]"} data-shell-library-notice>
            {notice.text}
          </p>
        )}
        {library.macros.length === 0 && (
          <EmptyState title="No saved jobs yet.">Add an action below, or press New job.</EmptyState>
        )}
        {folders.map((folder) => (
          <div key={folder} className="flex flex-col gap-1" data-shell-folder={folder}>
            <h4 className="font-mono text-[11px] uppercase tracking-wider text-[var(--pc-muted)]">{folder}</h4>
            <ul className="flex flex-col gap-1">
              {library.macros
                .filter((macro) => (macro.folder || "Custom") === folder)
                .map((macro) => (
                  <li
                    key={macro.id}
                    data-macro={macro.name}
                    className={`flex flex-wrap items-center gap-2 rounded-xl border px-2 py-1 ${macro.id === openId ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]"}`}
                  >
                    <button type="button" className="flex min-h-10 min-w-0 flex-1 flex-col items-start text-left" onClick={() => onOpen(macro.id)}>
                      <span className="text-sm font-medium text-[var(--pc-ink)]">{macro.name}</span>
                      <span className="font-mono text-[11px] text-[var(--pc-muted)]">
                        {macro.steps.length} step{macro.steps.length === 1 ? "" : "s"}
                        {(macro.repeat ?? 1) > 1 ? ` · ×${macro.repeat}` : ""}
                        {macro.id === openId ? " · open in Builder" : ""}
                      </span>
                    </button>
                    <Mini label="Open" onClick={() => onOpen(macro.id)} />
                    <Mini
                      label="Duplicate"
                      onClick={() =>
                        updateLibrary((current) => ({
                          ...current,
                          macros: [
                            ...current.macros,
                            {
                              ...macro,
                              id: newId("macro"),
                              name: uniqueName(`${macro.name} copy`, current.macros.map((m) => m.name)),
                              steps: macro.steps.map((step) => ({ ...step, id: newId("step") })),
                            },
                          ],
                        }))
                      }
                    />
                    <Mini
                      label="Rename"
                      onClick={() => {
                        const name = window.prompt("Rename job", macro.name);
                        if (!name?.trim()) return;
                        updateLibrary((current) => {
                          const others = current.macros.filter((item) => item.id !== macro.id).map((item) => item.name);
                          const unique = uniqueName(name, others);
                          if (unique !== name.trim()) setNotice({ tone: "ok", text: `“${name.trim()}” is taken; renamed to “${unique}”.` });
                          return { ...current, macros: current.macros.map((item) => (item.id === macro.id ? { ...item, name: unique } : item)) };
                        });
                      }}
                    />
                    <Mini label="Export" onClick={() => void saveTextFile(exportShellScript(macro), shellFileName(macro.name))} />
                    <Mini label="Delete" onClick={() => setDeleting(macro)} />
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3" data-shell-actions>
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Actions</h3>
          <p className="text-xs text-[var(--pc-muted)]">
            {open ? (
              <>
                Add sends the action to <span className="font-semibold text-[var(--pc-ink)]">“{open.name}”</span> in the Builder.
              </>
            ) : (
              "No job is open: Add creates a new job with that action."
            )}{" "}
            <span className="font-mono">Shell</span> and <span className="font-mono">File</span> actions need ADB on the phone; <span className="font-mono">Touch</span> actions simulate a finger on the screen.
          </p>
        </div>
        {CATEGORIES.map((category) => (
          <div key={category} className="flex flex-col gap-1.5" data-shell-category={category}>
            <h4 className="font-mono text-[11px] uppercase tracking-wider text-[var(--pc-muted)]">{category}</h4>
            <ul className="grid gap-2 @xl:grid-cols-2 @5xl:grid-cols-3">
              {ACTIONS.filter((a) => a.category === category).map((action) => (
                <li key={action.kind} className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-2.5" data-shell-action={action.kind}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--pc-ink)]">{action.label}</span>
                    <MechanismBadge mechanism={action.mechanism} />
                  </div>
                  <p className="text-[11px] text-[var(--pc-muted)]">{action.description}</p>
                  {action.recordedOnly ? (
                    <p className="text-[11px] italic text-[var(--pc-muted)]">Made with Record touches in Control; appears here as a job in “Recorded”.</p>
                  ) : (
                    <button
                      type="button"
                      className="pc-toggle pc-toggle-sm self-start"
                      onClick={() => onAddAction(action.kind)}
                      data-shell-library-add={action.kind}
                    >
                      Add{open ? ` to “${open.name}”` : " to a new job"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          body={`Its ${deleting.steps.length} steps are removed. Export it first to keep a copy.`}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            updateLibrary((current) => ({ ...current, macros: current.macros.filter((item) => item.id !== id) }));
          }}
        />
      )}
    </div>
  );
}

function VariablesEditor() {
  const library = useLibrary();
  const desk = useDesk();
  const [name, setName] = useState("USERNAME");
  const [value, setValue] = useState("");
  const [deviceId, setDeviceId] = useState("");

  return (
    <div className="flex flex-col gap-3">
      <ul className="font-mono text-xs">
        {Object.entries(library.variables).map(([key, item]) => (
          <li key={key}>
            {key} = {item}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          updateLibrary((current) => {
            if (deviceId) {
              return {
                ...current,
                deviceVariables: {
                  ...current.deviceVariables,
                  [deviceId]: { ...(current.deviceVariables[deviceId] ?? {}), [name]: value },
                },
              };
            }
            return { ...current, variables: { ...current.variables, [name]: value } };
          });
        }}
      >
        <TextField label="Name" value={name} onChange={setName} />
        <TextField label="Value" value={value} onChange={setValue} />
        <label className="text-sm">
          Device
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} className="mt-1 h-11 rounded-lg border px-2">
            <option value="">Global</option>
            {desk.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        <PrimaryButton type="submit">Save</PrimaryButton>
      </form>
      {desk.devices.map((device) => {
        const vars = library.deviceVariables[device.id];
        if (!vars || Object.keys(vars).length === 0) return null;
        return (
          <p key={device.id} className="font-mono text-xs">
            {device.name} {Object.entries(vars).map(([key, item]) => `${key} = ${item}`).join(", ")}
          </p>
        );
      })}
    </div>
  );
}

function GroupsEditor() {
  const library = useLibrary();
  const desk = useDesk();
  const [name, setName] = useState("Gaming");
  const [checked, setChecked] = useChecked(desk.devices, desk.targets);

  return (
    <div className="flex flex-col gap-3">
      {library.groups.map((group) => (
        <section key={group.id}>
          <h3 className="font-display text-sm font-semibold">{group.name}</h3>
          <ul className="font-mono text-xs">
            {group.deviceIds.map((id) => (
              <li key={id}>{desk.devices.find((device) => device.id === id)?.name ?? id}</li>
            ))}
          </ul>
          <button
            type="button"
            className="h-9 text-xs"
            onClick={() =>
              updateLibrary((current) => ({
                ...current,
                groups: current.groups.filter((item) => item.id !== group.id),
              }))
            }
          >
            Delete
          </button>
        </section>
      ))}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          updateLibrary((current) => ({
            ...current,
            groups: [...current.groups, { id: newId("group"), name, deviceIds: [...checked] }],
          }));
        }}
      >
        <TextField label="Group name" value={name} onChange={setName} />
        <TargetChecks devices={desk.devices} checked={checked} onChange={setChecked} />
        <PrimaryButton type="submit">Create group</PrimaryButton>
      </form>
    </div>
  );
}

function ProfilesEditor() {
  const library = useLibrary();
  const desk = useDesk();
  const [deviceId, setDeviceId] = useState(desk.activeDevice?.id ?? desk.devices[0]?.id ?? "");
  const profile = library.profiles[deviceId] ?? emptyProfile();
  const device = desk.devices.find((item) => item.id === deviceId);
  const [tag, setTag] = useState("");

  function save(next: DeviceProfile) {
    updateLibrary((current) => ({
      ...current,
      profiles: { ...current.profiles, [deviceId]: next },
    }));
  }

  if (!device) return <p className="text-sm">No devices.</p>;
  return (
    <div className="flex flex-col gap-2" data-device-profile>
      <label className="text-sm">
        Device
        <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-2">
          {desk.devices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 text-sm">
        <dt>Name</dt><dd>{device.name}</dd>
        <dt>Model</dt><dd>{device.model}</dd>
        <dt>Serial</dt><dd className="font-mono text-xs">{device.serial}</dd>
        <dt>Host</dt><dd>{device.host}</dd>
      </dl>
      <label className="text-sm">
        Assigned macros
        <select
          multiple
          value={profile.assignedMacros}
          onChange={(event) =>
            save({
              ...profile,
              assignedMacros: [...event.target.selectedOptions].map((option) => option.value),
            })
          }
          className="mt-1 min-h-24 w-full rounded-lg border px-2"
        >
          {library.macros.map((macro) => (
            <option key={macro.id} value={macro.id}>
              {macro.name}
            </option>
          ))}
        </select>
      </label>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const clean = tag.replace(/^#/, "").trim();
          if (!clean) return;
          updateLibrary((current) => ({
            ...current,
            tags: {
              ...current.tags,
              [deviceId]: [...new Set([...(current.tags[deviceId] ?? []), clean])],
            },
          }));
          setTag("");
        }}
      >
        <TextField label="Tag" value={tag} onChange={setTag} placeholder="gaming" />
        <PrimaryButton type="submit">Add tag</PrimaryButton>
      </form>
      <div className="flex flex-wrap gap-2">
        {(library.tags[deviceId] ?? []).map((item) => (
          <button
            key={item}
            type="button"
            className="h-9 rounded-full bg-[var(--pc-accent-soft)] px-2 text-xs"
            onClick={() =>
              updateLibrary((current) => ({
                ...current,
                tags: {
                  ...current.tags,
                  [deviceId]: (current.tags[deviceId] ?? []).filter((tagName) => tagName !== item),
                },
              }))
            }
          >
            #{item}
          </button>
        ))}
      </div>
    </div>
  );
}

function HistoryList() {
  const library = useLibrary();
  if (library.history.length === 0) return <p className="text-sm text-[var(--pc-muted)]">No runs yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {library.history.map((run) => (
        <li key={run.id} className="rounded-lg border border-[var(--pc-line)] p-2 text-sm">
          <p>
            {run.macroName} · {run.parallel ? "Parallel" : "Sequential"} · {new Date(run.at).toLocaleTimeString()}
          </p>
          <ul className="font-mono text-xs">
            {run.results.map((result) => (
              <li key={result.deviceId}>
                {result.deviceName} {result.status}
                {result.detail ? ` ${result.detail}` : ""}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Mini({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="h-9 px-2 text-xs text-[var(--pc-accent)]" onClick={onClick}>
      {label}
    </button>
  );
}
