#!/usr/bin/env python3
"""Сводка по трассе решений turn-lock (docs/logs.md).

Читает `lock-YYYY-MM-DD.jsonl`, печатает покрытие, поток событий, лизы,
границы шагов, очередь, гейт и список аномалий. Только чтение, без зависимостей.

    python tools/trace-report.py                 # сегодняшний файл
    python tools/trace-report.py path/to/file    # конкретный день
    python tools/trace-report.py dir/            # все файлы в каталоге
"""

from __future__ import annotations

import json
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

TIMER_RELEASES = {"no tool started", "no continuation"}


def fmt_ms(ms: int | float | None) -> str:
    if ms is None:
        return "-"
    return datetime.fromtimestamp(float(ms) / 1000).strftime("%m-%d %H:%M:%S")


def row_ms(row: dict) -> float | None:
    """Timestamp of a line, preferring `t` when `ms` disagrees.

    Early builds let a payload field named `ms` (a duration) overwrite the
    timestamp, so a day file can hold lines with `ms: 1000`. The ISO field is
    authoritative; `ms` is used only when it agrees or `t` is unreadable.
    """
    raw = row.get("ms")
    numeric = float(raw) if isinstance(raw, (int, float)) else None
    stamp = row.get("t")
    if isinstance(stamp, str):
        try:
            parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            return numeric
        if numeric is None or abs(parsed - numeric) > 2_000:
            return parsed
    return numeric


def fmt_dur(ms: int | float | None) -> str:
    if ms is None:
        return "-"
    seconds = float(ms) / 1000
    if seconds < 90:
        return f"{seconds:.1f}s"
    if seconds < 5400:
        return f"{seconds / 60:.1f}m"
    return f"{seconds / 3600:.1f}h"


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * q))))
    return ordered[index]


def resolve_paths(args: list[str]) -> list[Path]:
    if args:
        paths: list[Path] = []
        for raw in args:
            path = Path(raw)
            if path.is_dir():
                paths.extend(sorted(path.glob("lock-*.jsonl")))
            elif path.exists():
                paths.append(path)
            else:
                raise SystemExit(f"нет такого файла: {path}")
        if not paths:
            raise SystemExit("в каталоге нет файлов lock-*.jsonl")
        return paths

    base = Path(tempfile.gettempdir()) / "opencode" / "turn-lock-trace"
    today = base / f"lock-{datetime.now():%Y-%m-%d}.jsonl"
    if today.exists():
        return [today]
    if base.is_dir():
        found = sorted(base.glob("lock-*.jsonl"))
        if found:
            return found
    raise SystemExit(f"трасса не найдена: {today} (передайте путь явно)")


class Report:
    def __init__(self) -> None:
        self.lines = 0
        self.bad = 0
        self.first_ms: float | None = None
        self.last_ms: float | None = None
        self.events = Counter()
        self.recv_types = Counter()
        self.ignore_why = Counter()
        self.drop_why = Counter()
        self.instances: dict[tuple[int, str], Counter] = defaultdict(Counter)
        self.boot_limit: dict[int, int] = {}
        self.boot_scope: dict[int, str] = {}
        self.boot_lease_timeout: dict[int, float] = {}
        self.releases: list[dict] = []
        self.taken = 0
        self.taken_sid = Counter()
        self.released_sid = Counter()
        self.stale_sid = Counter()
        self.finishes = Counter()
        self.arm = 0
        self.fire = 0
        self.tool_release = 0
        self.step_release = 0
        self.step_handoff = 0
        self.waits = 0
        self.grants = 0
        self.grant_waits: list[float] = []
        self.timeouts = 0
        self.over_grants = 0
        self.gate = Counter()
        self.reacquire = 0
        self.yields = 0
        self.stream_closes: list[dict] = []
        self.stream_opens = 0
        self.last_snapshot: dict[int, list] = {}
        self.last_event_gap_ms = 0
        self._prev_recv_ms: float | None = None
        self.shutdown_held: list[str] = []
        self.snapshot_over_limit: list[str] = []
        self.unrefreshed: set[str] = set()

    def feed(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            self.bad += 1
            return
        self.lines += 1
        ms = row_ms(row)
        if isinstance(ms, (int, float)):
            at = float(ms)
            self.first_ms = at if self.first_ms is None else min(self.first_ms, at)
            self.last_ms = at if self.last_ms is None else max(self.last_ms, at)
        ev = row.get("ev", "?")
        self.events[ev] += 1
        pid = row.get("pid")
        owner = row.get("owner")
        if pid is not None:
            self.instances[(pid, owner)][ev] += 1

        if ev == "event.recv":
            self.recv_types[row.get("type")] += 1
            if isinstance(ms, (int, float)):
                at = float(ms)
                if self._prev_recv_ms is not None:
                    self.last_event_gap_ms = max(self.last_event_gap_ms, at - self._prev_recv_ms)
                self._prev_recv_ms = at
        elif ev == "event.ignore":
            self.ignore_why[row.get("why")] += 1
        elif ev == "event.drop":
            self.drop_why[row.get("why")] += 1
        elif ev == "boot":
            if isinstance(pid, int):
                self.boot_limit[pid] = row.get("limit", 1)
                self.boot_scope[pid] = row.get("scope", "?")
                if isinstance(row.get("leaseTimeoutMs"), (int, float)):
                    self.boot_lease_timeout[pid] = float(row["leaseTimeoutMs"])
        elif ev == "shutdown":
            for sid in row.get("held") or []:
                self.shutdown_held.append(f"{sid} (pid {pid})")
        elif ev == "stream.open":
            self.stream_opens += 1
        elif ev == "stream.closed":
            self.stream_closes.append(row)
        elif ev == "release":
            self.releases.append(row)
            sid = row.get("sid")
            if sid:
                self.released_sid[sid] += 1
        elif ev == "stale":
            sid = row.get("sid")
            if sid:
                self.stale_sid[sid] += 1
        elif ev == "lease.taken":
            self.taken += 1
            sid = row.get("sid")
            if sid:
                self.taken_sid[sid] += 1
        elif ev == "step.handoff":
            self.step_handoff += 1
        elif ev == "handoff.arm":
            self.arm += 1
        elif ev == "handoff.fire":
            self.fire += 1
        elif ev == "tool.release":
            self.tool_release += 1
        elif ev == "step.release":
            self.step_release += 1
        elif ev == "wait":
            self.waits += 1
        elif ev == "grant":
            self.grants += 1
            if row.get("waited"):
                self.grant_waits.append(float(row.get("waitedMs") or 0))
            if row.get("overLimit"):
                self.over_grants += 1
        elif ev == "timeout":
            self.timeouts += 1
        elif ev == "context.enter":
            self.gate["enter"] += 1
        elif ev == "context.cloud":
            self.gate["cloud"] += 1
        elif ev == "context.continue":
            self.gate["continue"] += 1
        elif ev == "context.covered":
            self.gate["covered"] += 1
        elif ev == "context.subagent":
            self.gate["subagent"] += 1
        elif ev == "context.reacquire":
            self.reacquire += 1
        elif ev == "yield":
            self.yields += 1
        if ev == "event.recv" and row.get("type") == "session.step.ended":
            self.finishes[row.get("finish") or "(пусто)"] += 1
        if ev == "snapshot" and isinstance(pid, int):
            leases = row.get("leases") or []
            self.last_snapshot[pid] = leases
            limit = self.boot_limit.get(pid, 1)
            if len(leases) > limit and not all(lease.get("over") for lease in leases[limit:]):
                self.snapshot_over_limit.append(
                    f"{fmt_ms(ms)} pid {pid}: {len(leases)} лизов при limit {limit}"
                )
            lease_timeout = self.boot_lease_timeout.get(pid)
            if lease_timeout:
                for lease in leases:
                    stale = lease.get("staleMs")
                    if isinstance(stale, (int, float)) and stale > lease_timeout:
                        self.unrefreshed.add(str(lease.get("sid")))

    # --- печать -------------------------------------------------------------

    def print(self) -> None:
        print("=" * 78)
        print(f"строк: {self.lines}" + (f"   битых: {self.bad}" if self.bad else ""))
        print(f"период: {fmt_ms(self.first_ms)} — {fmt_ms(self.last_ms)}"
              f"  ({fmt_dur((self.last_ms or 0) - (self.first_ms or 0))})")
        print()
        self._print_instances()
        self._print_stream()
        self._print_leases()
        self._print_steps()
        self._print_queue()
        self._print_gate()
        self._print_anomalies()
        print("=" * 78)

    def _print_instances(self) -> None:
        print(f"инстансы: {len(self.instances)}  (pid @ локация)")
        for (pid, owner), counts in sorted(self.instances.items(), key=lambda item: (item[0][1] or "", item[0][0])):
            print(
                f"  {pid:>7}  {str(owner)[:46]:<46}  boot={counts['boot']:<2}"
                f" shutdown={counts['shutdown']:<2} recv={counts['event.recv']:<6}"
                f" limit={self.boot_limit.get(pid, '?')} scope={self.boot_scope.get(pid, '?')}"
            )
        print()

    def _print_stream(self) -> None:
        print(f"поток событий: open={self.stream_opens}  closed={len(self.stream_closes)}"
              f"  макс. пауза между событиями={fmt_dur(self.last_event_gap_ms)}")
        bad = [row for row in self.stream_closes if not row.get("aborted")]
        for row in bad:
            print(f"  ! нештатное закрытие pid {row.get('pid')}: how={row.get('how')}"
                  f" events={row.get('events')} lived={fmt_dur(row.get('livedMs'))}"
                  f" error={row.get('error')}")
        if self.recv_types:
            print("  получено: " + ", ".join(
                f"{name}={count}" for name, count in self.recv_types.most_common(8)
            ))
        if self.ignore_why:
            print("  проигнорировано: " + ", ".join(
                f"{why}={count}" for why, count in self.ignore_why.most_common(5)
            ))
        if self.drop_why:
            print("  выброшено: " + ", ".join(
                f"{why}={count}" for why, count in self.drop_why.most_common(3)
            ))
        print()

    def _print_leases(self) -> None:
        ages = [float(row["ageMs"]) for row in self.releases if isinstance(row.get("ageMs"), (int, float))]
        print(f"лизы: выдач запросам={self.taken}  отпусканий={len(self.releases)}"
              f"  stale={sum(self.stale_sid.values())}")
        print("  (одна лиза может обслужить несколько запросов, поэтому числа не обязаны совпадать)")
        if ages:
            print(f"  удержание: p50={fmt_dur(percentile(ages, 0.5))}"
                  f"  p95={fmt_dur(percentile(ages, 0.95))}  max={fmt_dur(max(ages))}")
        by_reason = Counter(row.get("reason") or "?" for row in self.releases)
        for reason, count in by_reason.most_common():
            subset = [float(row["ageMs"]) for row in self.releases
                      if (row.get("reason") or "?") == reason and isinstance(row.get("ageMs"), (int, float))]
            extra = f"  медиана={fmt_dur(percentile(subset, 0.5))}" if subset else ""
            print(f"  {reason:<34} {count:>5}{extra}")
        live = {lease.get("sid") for leases in self.last_snapshot.values() for lease in leases}
        print(f"  в последнем срезе: {len(live)} разных лизов (дубли по инстансам схлопнуты)")
        if self.shutdown_held:
            print(f"  на выгрузке инстанса ещё висели: {len(self.shutdown_held)}"
                  f" (закрываются строкой release с reason=unload)")
        print()

    def _print_steps(self) -> None:
        print(f"границы шага: step.handoff={self.step_handoff}  arm={self.arm}"
              f"  fire={self.fire}  tool.release={self.tool_release}  step.release={self.step_release}")
        if self.finishes:
            print("  finish: " + ", ".join(f"{name}={count}" for name, count in self.finishes.most_common()))
        timer = sum(1 for row in self.releases if row.get("reason") in TIMER_RELEASES)
        print(f"  отпущено таймером (не событием): {timer}")
        print()

    def _print_queue(self) -> None:
        print(f"очередь: wait-тиков={self.waits}  выдач={self.grants}  timeout={self.timeouts}"
              f"  сверх лимита={self.over_grants}")
        if self.grant_waits:
            print(f"  ожидание до выдачи: p50={fmt_dur(percentile(self.grant_waits, 0.5))}"
                  f"  p95={fmt_dur(percentile(self.grant_waits, 0.95))}"
                  f"  max={fmt_dur(max(self.grant_waits))}")
        print()

    def _print_gate(self) -> None:
        print("гейт: " + ", ".join(f"{name}={count}" for name, count in self.gate.most_common())
              + f"  yield={self.yields}  reacquire={self.reacquire}")
        print()

    def _print_anomalies(self) -> None:
        found: list[str] = []
        for row in self.stream_closes:
            if not row.get("aborted"):
                found.append(f"поток закрылся сам (pid {row.get('pid')}, {row.get('how')}): {row.get('error')}")
        if self.reacquire:
            found.append(f"context.reacquire={self.reacquire}: шаг держал лиз, но step.ended не дошёл")
        if self.stale_sid:
            found.append(f"stale-лизов={sum(self.stale_sid.values())}: лиз пережил владельца")
        timer = sum(1 for row in self.releases if row.get("reason") in TIMER_RELEASES)
        if timer:
            found.append(f"таймер отпустил лиз {timer} раз: {', '.join(sorted({str(r.get('reason')) for r in self.releases if r.get('reason') in TIMER_RELEASES}))}")
        if self.over_grants:
            found.append(f"выдач сверх лимита={self.over_grants} (ожидаемо только после acquireTimeoutMs)")
        if self.unrefreshed:
            found.append(
                "лизы без refresh дольше leaseTimeoutMs: "
                + ", ".join(sorted(self.unrefreshed)[:5])
            )
        if self.snapshot_over_limit:
            found.append("лимит превышен в срезе: " + "; ".join(self.snapshot_over_limit[:3]))
        if not found:
            print("аномалии: не найдено")
        else:
            print("аномалии:")
            for item in found:
                print(f"  ! {item}")
        print()


def main() -> int:
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8", errors="replace")
    paths = resolve_paths(sys.argv[1:])
    report = Report()
    for path in paths:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                report.feed(line)
    print(f"файлы: {', '.join(str(path) for path in paths)}")
    report.print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
