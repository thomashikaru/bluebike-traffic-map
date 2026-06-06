#!/usr/bin/env python3
"""
Aggregate Bluebikes trip CSV(s) into per-station slot-level departures, arrivals, and net
(arrivals - departures), split by weekday and weekend (America/New_York).

Also precomputes:
  - Per-station color scale endpoints (expectedMin, expectedMax).
  - Grid-based vector field written to grid_vectors.json: for each grid cell and
    (day_type, slot), the mean unit ride-displacement vector is stored.  Each ride
    contributes its unit vector to N_SAMPLES evenly-spaced points along its path.

Usage:
  python3 src/build_station_hourly_json.py
  python3 src/build_station_hourly_json.py data/202310-bluebikes-tripdata.csv -o web/data/stations_hourly.json
  python3 src/build_station_hourly_json.py --slots-per-day 48 data/*.csv
  python3 src/build_station_hourly_json.py data/*.csv --grid-rows 30 --grid-cols 35
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

TZ = "America/New_York"
GRID_PAD = 0.015  # degrees of padding around ride-endpoint extents
N_SAMPLES = 5  # points sampled along each ride's straight-line path


def _validate_slots_per_day(n: int) -> None:
    if n < 1 or 1440 % n != 0:
        raise ValueError(
            f"slots_per_day must be a positive divisor of 1440 (got {n}); "
            "e.g. 24, 48, 96 for whole-minute alignment."
        )


def _slot_from_timestamp(ts: pd.Series, slots_per_day: int) -> pd.Series:
    """Clock slot index 0 .. slots_per_day-1 from local timestamps."""
    span_min = 1440 // slots_per_day
    minutes = ts.dt.hour.astype("int64") * 60 + ts.dt.minute.astype("int64")
    slot = minutes // span_min
    return slot.clip(0, slots_per_day - 1).astype("int64")


def _day_type_from_timestamp(ts: pd.Series) -> pd.Series:
    """Monday–Friday → weekday; Saturday/Sunday → weekend."""
    dow = ts.dt.dayofweek

    def _map(d: int) -> str:
        if d < 5:
            return "weekday"
        return "weekend"

    return dow.map(_map)


def _day_type_from_dow(dow: np.ndarray) -> np.ndarray:
    out = np.empty(len(dow), dtype=object)
    out[dow < 5] = "weekday"
    out[dow >= 5] = "weekend"
    return out


def _load_csvs(paths: list[Path]) -> pd.DataFrame:
    frames = []
    for p in paths:
        if not p.exists():
            raise FileNotFoundError(p)
        frames.append(pd.read_csv(p))
    return pd.concat(frames, ignore_index=True)


def _clean_ids(df: pd.DataFrame) -> pd.DataFrame:
    for col in ("start_station_id", "end_station_id"):
        if col not in df.columns:
            continue
        s = df[col].astype("string")
        s = s.str.strip()
        s = s.mask(s == "", pd.NA)
        df[col] = s
    return df


def _to_tz(series: pd.Series) -> pd.Series:
    dt = pd.to_datetime(series, errors="coerce")
    if getattr(dt.dt, "tz", None) is None:
        dt = dt.dt.tz_localize(TZ, ambiguous="NaT", nonexistent="shift_forward")
    else:
        dt = dt.dt.tz_convert(TZ)
    return dt


def station_metadata(df: pd.DataFrame) -> pd.DataFrame:
    """Per station: lat, lng, name (mode); prefer start-side coords/name, else end-only."""

    def _mode_name(s: pd.Series) -> str:
        s = s.dropna()
        if s.empty:
            return ""
        vc = s.astype(str).value_counts()
        return str(vc.index[0])

    meta_rows = []

    dep = df.dropna(subset=["start_station_id"]).copy()
    if not dep.empty:
        g = dep.groupby("start_station_id", dropna=False).agg(
            lat=("start_lat", "median"),
            lng=("start_lng", "median"),
            name=("start_station_name", _mode_name),
        )
        g["source"] = "start"
        meta_rows.append(g)

    arr = df.dropna(subset=["end_station_id"]).copy()
    if not arr.empty:
        g2 = arr.groupby("end_station_id", dropna=False).agg(
            lat=("end_lat", "median"),
            lng=("end_lng", "median"),
            name=("end_station_name", _mode_name),
        )
        g2["source"] = "end"
        meta_rows.append(g2)

    if not meta_rows:
        return pd.DataFrame(columns=["id", "lat", "lng", "name"])

    all_meta = pd.concat(meta_rows)
    all_meta = all_meta.sort_values(
        "source", key=lambda c: c.map({"start": 0, "end": 1})
    )
    out = all_meta.groupby(all_meta.index).first()
    out = out.rename_axis("id").reset_index()
    out = out.drop(columns=["source"], errors="ignore")
    out["name"] = out["name"].fillna("")
    return out


def aggregate_station_slot_and_scales(
    df: pd.DataFrame,
    slots_per_day: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns:
      totals: columns station_id, day_type, slot, dep_sum, arr_sum, n_days
      scales: columns station_id, day_type, expected_min, expected_max
    """
    dep_rows = df.dropna(subset=["start_station_id"]).copy()
    st = _to_tz(dep_rows["started_at"])
    dep_rows = dep_rows.loc[st.notna()].copy()
    st = st.loc[st.notna()]
    dep_rows["station_id"] = dep_rows["start_station_id"].astype("string")
    dep_rows["d"] = st.dt.normalize()
    dep_rows["slot"] = _slot_from_timestamp(st, slots_per_day)
    dep_g = (
        dep_rows.groupby(["station_id", "d", "slot"], observed=False)
        .size()
        .rename("dep")
    )

    arr_rows = df.dropna(subset=["end_station_id"]).copy()
    et = _to_tz(arr_rows["ended_at"])
    arr_rows = arr_rows.loc[et.notna()].copy()
    et = et.loc[et.notna()]
    arr_rows["station_id"] = arr_rows["end_station_id"].astype("string")
    arr_rows["d"] = et.dt.normalize()
    arr_rows["slot"] = _slot_from_timestamp(et, slots_per_day)
    arr_g = (
        arr_rows.groupby(["station_id", "d", "slot"], observed=False)
        .size()
        .rename("arr")
    )

    full = pd.concat([dep_g, arr_g], axis=1).fillna(0.0)
    full["net"] = full["arr"] - full["dep"]

    full = full.reset_index()
    piv = full.pivot_table(
        index=["station_id", "d"],
        columns="slot",
        values="net",
        aggfunc="sum",
        fill_value=0.0,
    )
    slot_cols = list(range(slots_per_day))
    piv = piv.reindex(columns=slot_cols, fill_value=0.0).fillna(0.0)
    daily_min = piv.min(axis=1)
    daily_max = piv.max(axis=1)
    d_index = piv.index.get_level_values("d")
    dow = pd.to_datetime(d_index).dayofweek.to_numpy()
    day_types = _day_type_from_dow(dow)
    dm = pd.DataFrame(
        {
            "station_id": piv.index.get_level_values("station_id").astype("string"),
            "d": d_index,
            "day_type": day_types,
            "daily_min": daily_min.values,
            "daily_max": daily_max.values,
        }
    )
    scales = (
        dm.groupby(["station_id", "day_type"], observed=False)
        .agg(expected_min=("daily_min", "mean"), expected_max=("daily_max", "mean"))
        .reset_index()
    )

    dep_rows["day_type"] = _day_type_from_timestamp(st)
    arr_rows["day_type"] = _day_type_from_timestamp(et)

    dep_slot = (
        dep_rows.groupby(["station_id", "day_type", "slot"], observed=False)
        .size()
        .rename("dep_sum")
    )
    arr_slot = (
        arr_rows.groupby(["station_id", "day_type", "slot"], observed=False)
        .size()
        .rename("arr_sum")
    )
    slot_tot = pd.concat([dep_slot, arr_slot], axis=1).fillna(0.0)

    n_days = (
        dm.groupby(["station_id", "day_type"], observed=False)["d"]
        .nunique()
        .rename("n_days")
    )

    slot_tot = slot_tot.reset_index()
    totals = slot_tot.merge(n_days, on=["station_id", "day_type"], how="left")
    totals["n_days"] = totals["n_days"].fillna(0).astype("int64")

    return totals, scales


def compute_grid_vectors(
    df: pd.DataFrame,
    slots_per_day: int,
    rows: int,
    cols: int,
) -> tuple[dict, dict]:
    """
    Compute a (rows × cols) grid of mean unit ride-displacement vectors for every
    (day_type, slot) combination.

    For each ride, N_SAMPLES points are sampled at equal intervals along the
    straight-line path from origin to destination.  The ride's unit vector
    (east=dx, north=dy) is accumulated into every cell that a sample point falls in.
    Averaging gives the mean flow direction through each map location.

    Grid convention: row 0 is the northernmost band (latMax), row rows-1 is
    southernmost (latMin).  Columns increase west-to-east.

    Returns
    -------
    bounds : dict  — latMin, latMax, lngMin, lngMax, rows, cols
    vectors : dict — keyed by day_type ("weekday"/"weekend"), each value
              {"dx": list[slots_per_day][rows*cols], "dy": list[...][...]}
              where dx[slot][row*cols+col] is the mean east component.
    """
    r = df.dropna(
        subset=["start_lat", "start_lng", "end_lat", "end_lng", "started_at"]
    ).copy()
    st = _to_tz(r["started_at"])
    r = r.loc[st.notna()].copy()
    st = st.loc[st.notna()]

    slat = r["start_lat"].astype(float).values
    slng = r["start_lng"].astype(float).values
    elat = r["end_lat"].astype(float).values
    elng = r["end_lng"].astype(float).values

    ddx = elng - slng  # east component
    ddy = elat - slat  # north component
    dist = np.hypot(ddx, ddy)

    # Compute slot/day_type before validity filter so index stays aligned
    slot_arr = _slot_from_timestamp(st, slots_per_day).values
    dt_arr = _day_type_from_timestamp(st).values

    valid = dist > 1e-9
    slat, slng, elat, elng = slat[valid], slng[valid], elat[valid], elng[valid]
    ddx, ddy, dist = ddx[valid], ddy[valid], dist[valid]
    slot_arr = slot_arr[valid]
    dt_arr = dt_arr[valid]

    ux = ddx / dist  # unit east
    uy = ddy / dist  # unit north

    # Grid bounds with padding; row 0 = north (latMax)
    lat_max = max(slat.max(), elat.max()) + GRID_PAD
    lat_min = min(slat.min(), elat.min()) - GRID_PAD
    lng_min = min(slng.min(), elng.min()) - GRID_PAD
    lng_max = max(slng.max(), elng.max()) + GRID_PAD
    lat_range = lat_max - lat_min
    lng_range = lng_max - lng_min

    # Sample N_SAMPLES points along each ride (fully vectorised)
    ts = np.linspace(0, 1, N_SAMPLES)  # (N_SAMPLES,)
    sample_lats = slat[:, None] + ts * (elat - slat)[:, None]  # (n, N_SAMPLES)
    sample_lngs = slng[:, None] + ts * (elng - slng)[:, None]

    sample_rows = np.clip(
        ((lat_max - sample_lats) / lat_range * rows).astype(int), 0, rows - 1
    )
    sample_cols = np.clip(
        ((sample_lngs - lng_min) / lng_range * cols).astype(int), 0, cols - 1
    )
    cell_indices = sample_rows * cols + sample_cols  # (n, N_SAMPLES)

    # Flatten: each sample point becomes one observation
    flat_cells = cell_indices.ravel()  # (n*N_SAMPLES,)
    flat_ux = np.repeat(ux, N_SAMPLES)
    flat_uy = np.repeat(uy, N_SAMPLES)
    flat_slot = np.repeat(slot_arr, N_SAMPLES)
    flat_dt = np.repeat(dt_arr, N_SAMPLES)

    n_cells = rows * cols
    combined_size = slots_per_day * n_cells
    vectors: dict = {}

    for dtype in ("weekday", "weekend"):
        mask = flat_dt == dtype
        if not mask.any():
            vectors[dtype] = {
                "dx": [[0.0] * n_cells for _ in range(slots_per_day)],
                "dy": [[0.0] * n_cells for _ in range(slots_per_day)],
                "n": [[0] * n_cells for _ in range(slots_per_day)],
            }
            continue

        # Combined index: slot * n_cells + cell_idx  → one bincount covers all slots
        combined_idx = flat_slot[mask].astype(int) * n_cells + flat_cells[mask].astype(
            int
        )
        dx_flat = np.bincount(
            combined_idx, weights=flat_ux[mask], minlength=combined_size
        )
        dy_flat = np.bincount(
            combined_idx, weights=flat_uy[mask], minlength=combined_size
        )
        cnt_flat = np.bincount(combined_idx, minlength=combined_size).astype(float)

        safe_cnt = np.where(cnt_flat > 0, cnt_flat, 1.0)
        mean_dx = (dx_flat / safe_cnt).reshape(slots_per_day, n_cells)
        mean_dy = (dy_flat / safe_cnt).reshape(slots_per_day, n_cells)
        no_data = (cnt_flat == 0).reshape(slots_per_day, n_cells)
        mean_dx[no_data] = 0.0
        mean_dy[no_data] = 0.0

        cnt_grid = cnt_flat.reshape(slots_per_day, n_cells)
        vectors[dtype] = {
            "dx": [
                [round(float(v), 4) for v in mean_dx[s]] for s in range(slots_per_day)
            ],
            "dy": [
                [round(float(v), 4) for v in mean_dy[s]] for s in range(slots_per_day)
            ],
            "n": [[int(v) for v in cnt_grid[s]] for s in range(slots_per_day)],
        }

    bounds = {
        "latMin": round(float(lat_min), 6),
        "latMax": round(float(lat_max), 6),
        "lngMin": round(float(lng_min), 6),
        "lngMax": round(float(lng_max), 6),
        "rows": rows,
        "cols": cols,
    }
    return bounds, vectors


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    default_csv = root / "data" / "202310-bluebikes-tripdata.csv"
    default_out = root / "web" / "data" / "stations_hourly.json"
    default_grid_out = root / "web" / "data" / "grid_vectors.json"

    ap = argparse.ArgumentParser(
        description="Build stations_hourly.json from Bluebikes trip CSV(s)."
    )
    ap.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        default=[default_csv],
        help=f"CSV file paths (default: {default_csv})",
    )
    ap.add_argument(
        "-o", "--output", type=Path, default=default_out, help="Output JSON path"
    )
    ap.add_argument(
        "--grid-output",
        type=Path,
        default=default_grid_out,
        help=f"Grid vectors output path (default: {default_grid_out})",
    )
    ap.add_argument(
        "--slots-per-day",
        type=int,
        default=48,
        help="Number of equal clock buckets per day (must divide 1440). Default 24 = hourly.",
    )
    ap.add_argument(
        "--grid-rows", type=int, default=80, help="Grid rows (N→S). Default 40."
    )
    ap.add_argument(
        "--grid-cols", type=int, default=80, help="Grid columns (W→E). Default 50."
    )
    args = ap.parse_args()

    inputs: list[Path] = list(args.inputs) or [default_csv]
    slots_per_day: int = args.slots_per_day
    _validate_slots_per_day(slots_per_day)

    df = _load_csvs(inputs)
    df = _clean_ids(df)

    meta = station_metadata(df)
    totals, scales = aggregate_station_slot_and_scales(df, slots_per_day)

    scale_keyed = scales.set_index(["station_id", "day_type"])

    slot_sums: pd.DataFrame = (
        totals
        if not totals.empty
        else pd.DataFrame(
            columns=["station_id", "day_type", "slot", "dep_sum", "arr_sum", "n_days"]
        )
    )

    slot_lookup: dict[tuple[str, str], tuple[int, np.ndarray, np.ndarray]] = {}
    if not slot_sums.empty:
        for (sid_key, dtype_key), grp in slot_sums.groupby(
            ["station_id", "day_type"], observed=True
        ):
            n = int(grp["n_days"].iloc[0])
            dep_arr = np.zeros(slots_per_day)
            arr_arr = np.zeros(slots_per_day)
            slot_idx = grp["slot"].to_numpy(dtype=int)
            dep_arr[slot_idx] = grp["dep_sum"].to_numpy()
            arr_arr[slot_idx] = grp["arr_sum"].to_numpy()
            slot_lookup[(str(sid_key), str(dtype_key))] = (n, dep_arr, arr_arr)

    station_ids = sorted(
        set(meta["id"].astype(str))
        | set(slot_sums["station_id"].astype(str))
        | set(scales["station_id"].astype(str))
    )

    meta_by_id = meta.set_index("id").to_dict("index") if not meta.empty else {}
    stations_out = []

    for sid in station_ids:
        m = meta_by_id.get(sid, {})
        lat = m.get("lat")
        lng = m.get("lng")
        name = str(m.get("name", "") or "")

        if pd.isna(lat) or pd.isna(lng):
            continue

        def pack(dtype: str) -> dict:
            key = (sid, dtype)
            if key in slot_lookup:
                n_days, dep_arr, arr_arr = slot_lookup[key]
            else:
                n_days = 0
                dep_arr = np.zeros(slots_per_day)
                arr_arr = np.zeros(slots_per_day)

            if n_days <= 0:
                dep_avg = [0.0] * slots_per_day
                arr_avg = [0.0] * slots_per_day
                net_avg = [0.0] * slots_per_day
            else:
                dep_avg = [round(float(v) / n_days, 4) for v in dep_arr]
                arr_avg = [round(float(v) / n_days, 4) for v in arr_arr]
                net_avg = [
                    round(arr_avg[i] - dep_avg[i], 4) for i in range(slots_per_day)
                ]

            try:
                smin = float(scale_keyed.loc[(sid, dtype), "expected_min"])
                smax = float(scale_keyed.loc[(sid, dtype), "expected_max"])
            except KeyError:
                smin, smax = 0.0, 0.0

            return {
                "dep": dep_avg,
                "arr": arr_avg,
                "net": net_avg,
                "scale": {
                    "expectedMin": round(smin, 4),
                    "expectedMax": round(smax, 4),
                    "nActiveDays": n_days,
                },
            }

        stations_out.append(
            {
                "id": sid,
                "name": name,
                "lat": float(lat),
                "lng": float(lng),
                "weekday": pack("weekday"),
                "weekend": pack("weekend"),
            }
        )

    stations_out.sort(key=lambda x: x["id"])

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tz": TZ,
        "meta": {
            "slotsPerDay": slots_per_day,
            "slotDurationMinutes": 1440 // slots_per_day,
            "dayTypes": ["weekday", "weekend"],
            "source_files": [p.name for p in inputs],
        },
        "stations": stations_out,
    }

    out_path: Path = args.output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote {out_path} ({len(stations_out)} stations, {slots_per_day} slots/day)")

    # ── Grid vector field ──────────────────────────────────────────────────
    print(f"Computing {args.grid_rows}×{args.grid_cols} grid vectors …")
    bounds, vectors = compute_grid_vectors(
        df, slots_per_day, args.grid_rows, args.grid_cols
    )
    grid_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "meta": {
            "slotsPerDay": slots_per_day,
            "slotDurationMinutes": 1440 // slots_per_day,
            "dayTypes": ["weekday", "weekend"],
            "source_files": [p.name for p in inputs],
            **bounds,
        },
        "weekday": vectors["weekday"],
        "weekend": vectors["weekend"],
    }
    grid_out: Path = args.grid_output
    grid_out.parent.mkdir(parents=True, exist_ok=True)
    with open(grid_out, "w", encoding="utf-8") as f:
        json.dump(grid_payload, f, separators=(",", ":"))
    print(
        f"Wrote {grid_out} "
        f"({args.grid_rows}×{args.grid_cols} cells, {slots_per_day} slots/day)"
    )


if __name__ == "__main__":
    main()
