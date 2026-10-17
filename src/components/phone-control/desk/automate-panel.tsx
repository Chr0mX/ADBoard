"use client";

import { useMemo, useState } from "react";
import { runMacro, type MacroProgress } from "@/lib/desk/run-macro";
import {
  MACRO_FOLDERS,
  emptyProfile,
  exportDeskJson,
  importDeskJson,
  newId,
  updateLibrary,
  useLibrary,
  type DeviceProfile,
  type MacroStep,
  type MacroStepKind,
  type SavedMacro,
} from "@/lib/desk/store";
import { useDesk } from "@/components/phone-control/desk/desk-context";
import {
  PanelFrame,
  PrimaryButton,
  TargetChecks,
  TextField,
  picked,
  useChecked,
} from "@/components/phone-control/desk/bits";

const KINDS: Array<{ id: MacroStepKind; label: string; group: string }> = [
  { id: "launch", label: "Launch App", group: "Device" },
  { id: "forceStop", label: "Force Stop App", group: "Device" },
  { id: "reboot", label: "Reboot", group: "Device" },
  { id: "shutdown", label: "Shutdown", group: "Device" },
  { id: "nav", label: "Home / Back / Recent / Power / Volume", group: "Device" },
  { id: "tap", label: "Tap", group: "Input" },
  { id: "doubleTap", label: "Double Tap", group: "Input" },
  { id: "longPress", label: "Long Press", group: "Input" },
  { id: "swipe", label: "Swipe", group: "Input" },
  { id: "scroll", label: "Scroll", group: "Input" },
  { id: "drag", label: "Drag", group: "Input" },
  { id: "pinch", label: "Pinch", group: "Input" },
  { id: "text", label: "Text Input", group: "Input" },
  { id: "wait", label: "Wait", group: "Timing" },
  { id: "waitDevice", label: "Wait for Device", group: "Timing" },
  { id: "waitApp", label: "Wait for App", group: "Timing" },
  { id: "waitScreen", label: "Wait for Screen", group: "Timing" },
  { id: "timeout", label: "Timeout", group: "Timing" },
  { id: "upload", label: "Upload File", group: "File" },
  { id: "download", label: "Download File", group: "File" },
  { id: "deleteFile", label: "Delete File", group: "File" },
  { id: "install", label: "Install APK", group: "File" },
  { id: "screenshot", label: "Screenshot", group: "Capture" },
  { id: "recordStart", label: "Start Recording", group: "Capture" },
  { id: "recordStop", label: "Stop Recording", group: "Capture" },
  { id: "shell", label: "Run Shell Command", group: "ADB" },
];

/** Tabs in the order you use them, each with a one-line hint and a plain explanation. */
const TABS = [
  {
    id: "library",
    label: "Library",
    sub: "Saved jobs",
    explain: "Your saved Automation jobs. Pick one to run it on the phones you tick, or open it in Builder.",
  },
  {
    id: "builder",
    label: "Builder",
    sub: "Make a job",
    explain:
      "Make a job step by step: launch or stop apps, tap, type, wait, install APKs, move files, run shell commands. Example: Force Stop game → Launch game → Wait 10 s → Tap Start.",
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

export function AutomatePanel() {
  const library = useLibrary();
  const desk = useDesk();
  const [tab, setTab] = useState(desk.focusTool || "library");
  const [macroId, setMacroId] = useState<string | null>(library.macros[0]?.id ?? null);
  const macro = library.macros.find((item) => item.id === macroId) ?? null;

  return (
    <PanelFrame title="Shell Automation" panel="automate">
      <p className="text-sm text-[var(--pc-muted)]">
        Shell Automation runs app, file and shell-command jobs on many phones. Finger-touch macros live in Touch Macros.
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
            <span className={`text-[10px] leading-tight ${tab === item.id ? "text-white/80" : "text-[var(--pc-muted)]"}`}>{item.sub}</span>
          </button>
        ))}
      </div>
      {TABS.find((item) => item.id === tab) && (
        <p className="text-xs text-[var(--pc-muted)]" data-automate-explain>
          {TABS.find((item) => item.id === tab)!.explain}
        </p>
      )}
      {tab === "library" && (
        <MacroLibrary
          selectedId={macroId}
          onSelect={(id) => {
            setMacroId(id);
            setTab("builder");
          }}
          onRun={(id) => {
            setMacroId(id);
            setTab("builder");
          }}
        />
      )}
      {tab === "builder" && (
        <MacroBuilder
          macro={macro}
          onCreate={(created) => setMacroId(created.id)}
        />
      )}
      {tab === "variables" && <VariablesEditor />}
      {tab === "groups" && <GroupsEditor />}
      {tab === "profiles" && <ProfilesEditor />}
      {tab === "history" && <HistoryList />}
    </PanelFrame>
  );
}

function MacroLibrary({
  selectedId,
  onSelect,
  onRun,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
}) {
  const library = useLibrary();
  const folders = useMemo(() => {
    const names = new Set<string>(MACRO_FOLDERS);
    for (const macro of library.macros) names.add(macro.folder || "Custom");
    return [...names];
  }, [library.macros]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Mini
          label="Export desk"
          onClick={() => {
            const blob = new Blob([exportDeskJson(library)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "phonecontrol-desk.json";
            link.click();
            URL.revokeObjectURL(url);
          }}
        />
        <label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-[var(--pc-line)] px-2 text-xs text-[var(--pc-ink)]">
          Import desk
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
                  importDeskJson(text);
                } catch (error) {
                  window.alert(
                    error instanceof Error ? error.message : "Could not import the desk file",
                  );
                }
              });
            }}
          />
        </label>
      </div>
      {folders.map((folder) => (
        <section key={folder}>
          <h3 className="font-display text-sm font-semibold">📁 {folder}</h3>
          <ul className="mt-1">
            {library.macros
              .filter((macro) => (macro.folder || "Custom") === folder)
              .map((macro) => (
                <li key={macro.id} data-macro={macro.name} className="flex flex-wrap items-center gap-1">
                  <span className={macro.id === selectedId ? "font-semibold" : ""}>{macro.name}</span>
                  <Mini label="Run" onClick={() => onRun(macro.id)} />
                  <Mini label="Edit" onClick={() => onSelect(macro.id)} />
                  <Mini
                    label="Duplicate"
                    onClick={() =>
                      updateLibrary((current) => ({
                        ...current,
                        macros: [
                          ...current.macros,
                          { ...macro, id: newId("macro"), name: `${macro.name} copy`, steps: macro.steps.map((step) => ({ ...step, id: newId("step") })) },
                        ],
                      }))
                    }
                  />
                  <Mini
                    label="Rename"
                    onClick={() => {
                      const name = window.prompt("Rename macro", macro.name);
                      if (!name) return;
                      updateLibrary((current) => ({
                        ...current,
                        macros: current.macros.map((item) => (item.id === macro.id ? { ...item, name } : item)),
                      }));
                    }}
                  />
                  <Mini
                    label="Delete"
                    onClick={() =>
                      updateLibrary((current) => ({
                        ...current,
                        macros: current.macros.filter((item) => item.id !== macro.id),
                      }))
                    }
                  />
                  <Mini
                    label="Export"
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(macro, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = `${macro.name}.json`;
                      anchor.click();
                      URL.revokeObjectURL(url);
                    }}
                  />
                </li>
              ))}
          </ul>
        </section>
      ))}
      <label className="text-sm">
        Import
        <input
          type="file"
          accept="application/json"
          className="mt-1 block text-xs"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              const parsed = JSON.parse(text) as SavedMacro;
              if (!parsed?.name || !Array.isArray(parsed.steps)) return;
              updateLibrary((current) => ({
                ...current,
                macros: [...current.macros, { ...parsed, id: newId("macro") }],
              }));
            });
          }}
        />
      </label>
    </div>
  );
}

function MacroBuilder({
  macro,
  onCreate,
}: {
  macro: SavedMacro | null;
  onCreate: (macro: SavedMacro) => void;
}) {
  const desk = useDesk();
  const library = useLibrary();
  const [checked, setChecked] = useChecked(desk.devices, desk.targets);
  const [parallel, setParallel] = useState(true);
  const [progress, setProgress] = useState<Record<string, MacroProgress>>({});
  const [running, setRunning] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("Testing");

  function patch(steps: MacroStep[]) {
    if (!macro) return;
    updateLibrary((current) => ({
      ...current,
      macros: current.macros.map((item) => (item.id === macro.id ? { ...item, steps } : item)),
    }));
  }

  const tagNames = [...new Set(Object.values(library.tags).flat())];

  return (
    <div className="flex flex-col gap-3" data-macro-builder>
      {!macro && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const created: SavedMacro = {
              id: newId("macro"),
              name: name || "New macro",
              folder,
              steps: [],
            };
            updateLibrary((current) => ({ ...current, macros: [...current.macros, created] }));
            onCreate(created);
          }}
        >
          <TextField label="Name" value={name} onChange={setName} placeholder="Login Test" />
          <label className="text-sm">
            Folder
            <select value={folder} onChange={(event) => setFolder(event.target.value)} className="mt-1 h-11 rounded-lg border px-2">
              {MACRO_FOLDERS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <PrimaryButton type="submit">Create</PrimaryButton>
        </form>
      )}
      {macro && (
        <>
          <p className="font-display text-sm font-semibold">
            Macro: {macro.name}
          </p>
          <ol className="flex flex-col gap-2">
            {macro.steps.map((step, index) => (
              <li key={step.id} className="rounded-lg border border-[var(--pc-line)] p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {index + 1}. {KINDS.find((kind) => kind.id === step.kind)?.label ?? step.kind}
                  </span>
                  <button
                    type="button"
                    className="h-9 px-2 text-xs"
                    onClick={() => patch(macro.steps.filter((item) => item.id !== step.id))}
                  >
                    Remove
                  </button>
                </div>
                <p className="font-mono text-[10px] text-[var(--pc-muted)]">{summarize(step)}</p>
              </li>
            ))}
          </ol>
          <StepForm
            onAdd={(step) => patch([...macro.steps, step])}
          />
          <div className="rounded-xl border border-[var(--pc-line)] p-3" data-macro-run>
            <p className="text-sm font-medium">Macro: {macro.name}</p>
            <TargetChecks devices={desk.devices} checked={checked} onChange={setChecked} />
            {tagNames.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="text-xs text-[var(--pc-muted)]">Run on</span>
                {tagNames.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="h-9 rounded-full border px-2 text-xs"
                    onClick={() => {
                      const next = new Set(checked);
                      for (const [deviceId, tags] of Object.entries(library.tags)) {
                        if (tags.includes(tag)) next.add(deviceId);
                      }
                      setChecked(next);
                    }}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
            <fieldset className="mt-2 flex flex-col gap-1">
              <legend className="mb-1 text-xs text-[var(--pc-muted)]">Execution</legend>
              <div className="pc-segmented max-w-sm" role="radiogroup" aria-label="Execution">
                <label className="pc-segment">
                  <input type="radio" name="macro-mode" className="sr-only" checked={parallel} onChange={() => setParallel(true)} />
                  Parallel
                </label>
                <label className="pc-segment">
                  <input type="radio" name="macro-mode" className="sr-only" checked={!parallel} onChange={() => setParallel(false)} />
                  Sequential
                </label>
              </div>
            </fieldset>
            <PrimaryButton
              disabled={running}
              onClick={() => {
                const devices = picked(desk.devices, checked);
                setRunning(true);
                setProgress({});
                const final = new Map<string, MacroProgress>();
                void runMacro({
                  macro,
                  devices,
                  parallel,
                  variables: library.variables,
                  deviceVariables: library.deviceVariables,
                  profiles: library.profiles,
                  onProgress: (item) => {
                    final.set(item.deviceId, item);
                    setProgress((prev) => ({ ...prev, [item.deviceId]: item }));
                  },
                }).finally(() => {
                  setRunning(false);
                  updateLibrary((current) => ({
                    ...current,
                    history: [
                      {
                        id: newId("run"),
                        macroId: macro.id,
                        macroName: macro.name,
                        at: Date.now(),
                        parallel,
                        results: [...final.values()].map((item) => ({
                          deviceId: item.deviceId,
                          deviceName: item.deviceName,
                          status: item.status,
                          detail: item.detail,
                        })),
                      },
                      ...current.history,
                    ].slice(0, 30),
                  }));
                });
              }}
            >
              RUN
            </PrimaryButton>
            <ul data-macro-progress className="mt-3 flex flex-col gap-2">
              {desk.devices.map((device) => {
                const item = progress[device.id];
                const selected = checked.has(device.id);
                const ratio = item && item.total > 0 ? Math.min(1, item.step / item.total) : 0;
                const label = !selected
                  ? "Not selected"
                  : item?.status === "done"
                    ? "Completed ✓"
                    : item?.status === "failed"
                      ? `Step ${item.step} failed`
                      : item?.status === "skipped"
                        ? "Not selected"
                        : item
                          ? `Step ${item.step}/${item.total}`
                          : "—";
                return (
                  <li key={device.id}>
                    <div className="flex justify-between font-mono text-xs">
                      <span>{device.name}</span>
                      <span>{label}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded bg-[var(--pc-line)]">
                      <div
                        className="h-full bg-[var(--pc-accent)]"
                        style={{ width: selected ? `${ratio * 100}%` : "0%" }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function StepForm({ onAdd }: { onAdd: (step: MacroStep) => void }) {
  const [kind, setKind] = useState<MacroStepKind>("tap");
  const [x, setX] = useState("50");
  const [y, setY] = useState("40");
  const [text, setText] = useState("");
  const [ms, setMs] = useState("2000");
  const [nav, setNav] = useState<MacroStep["nav"]>("home");

  return (
    <form
      className="grid gap-2 rounded-xl border border-[var(--pc-line)] p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onAdd({
          id: newId("step"),
          kind,
          x: Number(x),
          y: Number(y),
          x2: Number(x),
          y2: Math.max(0, Number(y) - 30),
          text,
          command: text,
          packageName: text,
          hostPath: text,
          ms: Number(ms) || 1000,
          nav,
          bitrate: "8000000",
          size: "1280x720",
          dest: "/sdcard/Movies",
        });
      }}
    >
      <label className="text-sm sm:col-span-2">
        Action
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as MacroStepKind)}
          className="mt-1 h-11 w-full rounded-lg border px-2"
        >
          {["Device", "Input", "Timing", "File", "Capture", "ADB"].map((group) => (
            <optgroup key={group} label={group}>
              {KINDS.filter((item) => item.group === group).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {["tap", "doubleTap", "longPress", "swipe", "scroll", "drag", "pinch"].includes(kind) && (
        <>
          <TextField label="X %" value={x} onChange={setX} />
          <TextField label="Y %" value={y} onChange={setY} />
        </>
      )}
      {["text", "shell", "launch", "forceStop", "waitApp", "upload", "download", "deleteFile", "install"].includes(kind) && (
        <TextField label="Value" value={text} onChange={setText} placeholder={kind === "text" ? "${USERNAME}" : "com.example.game"} />
      )}
      {["wait", "timeout", "waitDevice", "waitApp", "waitScreen"].includes(kind) && (
        <TextField label="Milliseconds" value={ms} onChange={setMs} />
      )}
      {kind === "nav" && (
        <label className="text-sm">
          Key
          <select value={nav} onChange={(event) => setNav(event.target.value as MacroStep["nav"])} className="mt-1 h-11 w-full rounded-lg border px-2">
            <option value="home">Home</option>
            <option value="back">Back</option>
            <option value="recent">Recent Apps</option>
            <option value="power">Power</option>
            <option value="volume_up">Volume Up</option>
            <option value="volume_down">Volume Down</option>
          </select>
        </label>
      )}
      <div className="sm:col-span-2">
        <PrimaryButton type="submit">Add step</PrimaryButton>
      </div>
    </form>
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

function summarize(step: MacroStep) {
  if (step.kind === "tap" || step.kind === "doubleTap" || step.kind === "longPress") {
    return `X: ${step.x ?? 50}%  Y: ${step.y ?? 50}%`;
  }
  if (step.kind === "text" || step.kind === "shell") return step.text || step.command || "";
  if (step.kind === "wait") return `${step.ms ?? 0} ms`;
  if (step.kind === "nav") return step.nav ?? "home";
  if (step.kind === "gesture") return `${step.samples?.length ?? 0} pointer events`;
  if (step.packageName) return step.packageName;
  return step.kind;
}
