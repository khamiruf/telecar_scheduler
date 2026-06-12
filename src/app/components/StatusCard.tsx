import { useRef, useState } from "react";
import type { CarStatus } from "@/shared/types";
import { api } from "../lib/api";
import { haptic } from "../lib/telegram";
import { agoLabel } from "../lib/time";

interface Props {
  status: CarStatus | null;
  onSaved: (status: CarStatus) => void;
}

export default function StatusCard({ status, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    haptic("light");
    setDraft(status?.level ?? "");
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const save = async () => {
    const level = draft.trim().toUpperCase();
    if (!level || saving) return;
    setSaving(true);
    try {
      const updated = await api.setLocation(level);
      onSaved(updated);
      haptic("success");
      setEditing(false);
    } catch {
      haptic("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rise overflow-hidden rounded-2xl bg-bg2">
      <div className="hazard" />
      <div className="px-5 pb-5 pt-4">
        <div className="flex items-baseline justify-between">
          <span className="font-sign text-[11px] font-semibold tracking-[0.28em] text-hint">
            CAR PARKED AT
          </span>
          {!editing && (
            <button onClick={startEditing} className="pressable font-sign text-sm font-semibold text-link">
              {status ? "Move" : "Set"}
            </button>
          )}
        </div>

        {editing ? (
          <form
            className="mt-2 flex items-center gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="4B"
              autoCapitalize="characters"
              autoCorrect="off"
              enterKeyHint="done"
              className="w-full min-w-0 rounded-xl border-2 border-paint bg-transparent px-4 py-2 font-sign text-4xl font-black tracking-tight outline-none placeholder:text-hint/40"
            />
            <button
              type="submit"
              disabled={saving || !draft.trim()}
              className="pressable shrink-0 rounded-xl bg-paint px-4 py-3 font-sign text-sm font-extrabold text-paint-ink disabled:opacity-40"
            >
              {saving ? "…" : "SAVE"}
            </button>
          </form>
        ) : (
          <button onClick={startEditing} className="block w-full text-left">
            {status ? (
              <div key={status.level + status.updatedAt} className="stamp">
                <div className="font-sign text-[64px] font-black leading-[1.05] tracking-tight">
                  {status.level}
                </div>
                <div className="mt-1 text-[13px] text-hint">
                  left by <span className="font-semibold text-ink">{status.updatedBy}</span> ·{" "}
                  {agoLabel(status.updatedAt)}
                </div>
              </div>
            ) : (
              <div className="mt-2 rounded-xl border-2 border-dashed border-hint/40 px-4 py-6 text-center">
                <div className="font-sign text-lg font-extrabold">Where's the car?</div>
                <div className="mt-1 text-[13px] text-hint">Tap to set the parking level</div>
              </div>
            )}
          </button>
        )}
      </div>
    </section>
  );
}
