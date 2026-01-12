// src/components/panels/FloorPanel.jsx
import React from "react";
import { getDeptColor } from "../../style/roomColors";

export default function FloorPanel({
  buildingName,
  floorLabel,
  stats, // { totalSf, rooms, classroomSf, classroomCount }
  legendItems = [], // [{ name, areaSf, color }]
  floors = [],
  selectedFloor,
  onChangeFloor,
  onLoadFloorplan,
  onUnloadFloorplan,
  onClose,
  onExportPDF,
  onExportCSV,
  colorMode = 'department',
  onChangeColorMode,
  legendTitle = 'Key Departments',
  legendSelection,
  onLegendClick,
  onExplainFloor,
  explainLoading = false,
  explainDisabled = false,
  explainError = '',
  moveScenarioMode = false,
  onToggleMoveScenarioMode,
}) {
  const area = (v) =>
    Number.isFinite(v) ? Math.round(v).toLocaleString() : "-";
  const count = (v) => (Number.isFinite(v) ? Number(v).toLocaleString() : "-");

  return (
    <div style={{ minWidth: 340, maxWidth: 380, padding: 12, fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700 }}>{buildingName}</div>
        <button onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 0.95fr) minmax(0, 1.05fr)",
          gap: 10,
          marginTop: 8,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>FLOOR TOTALS</div>
          <div>
            <b>Floor:</b> {floorLabel ?? "-"}
          </div>
          <div>
            <b>Total SF:</b> {area(stats?.totalSf)}
          </div>
          <div>
            <b>Rooms:</b> {count(stats?.rooms)}
          </div>
          <div>
            <b>Classroom SF:</b> {area(stats?.classroomSf)}
          </div>
          <div>
            <b>Classrooms:</b> {count(stats?.classroomCount)}
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{legendTitle}</div>
          {legendItems.length === 0 ? (
            <div style={{ color: "#666" }}>&mdash;</div>
          ) : (
            <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
              {legendItems.map((d) => (
                <div
                  key={d.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                    padding: "2px 0",
                    borderRadius: 4,
                    cursor: onLegendClick ? "pointer" : "default",
                    background: legendSelection === d.name ? "#f0f4ff" : "transparent",
                    fontSize: 12,
                    lineHeight: 1.25
                  }}
                  onClick={() => onLegendClick?.(d.name)}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: d.color || getDeptColor(d.name),
                      border: "1px solid #999",
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    {d.name} {Number.isFinite(d.areaSf || d.Area || d.sf)
                      ? ` (${Math.round((d.areaSf || d.Area || d.sf)).toLocaleString()} SF)`
                      : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <b>Floor</b>
          </div>
          <select
            value={selectedFloor ?? ""}
            onChange={(e) => onChangeFloor?.(e.target.value)}
          >
            {floors.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button onClick={onLoadFloorplan}>Load</button>
          {onUnloadFloorplan ? <button onClick={onUnloadFloorplan}>Unload</button> : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <button onClick={onExportPDF}>Export to PDF</button>
          {onExportCSV ? <button onClick={onExportCSV}>Export CSV</button> : null}
          <button
            onClick={onExplainFloor}
            disabled={explainDisabled || explainLoading}
          >
            {explainLoading ? "Explaining..." : "✨ Explain this floor"}
          </button>
        </div>
        {explainError ? (
          <div style={{ color: "crimson", fontSize: 12 }}>{explainError}</div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 600 }}>Highlight By</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
            {[
              { key: 'department', label: 'Department' },
              { key: 'type', label: 'Type' },
              { key: 'occupancy', label: 'Occupancy' },
              { key: 'vacancy', label: 'Vacancy' },
            ].map((opt) => (
              <label key={opt.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="highlight-mode"
                  value={opt.key}
                  checked={colorMode === opt.key}
                  onChange={(e) => onChangeColorMode?.(e.target.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        {onToggleMoveScenarioMode ? (
          <div style={{ marginTop: 6 }}>
            <button
              className="mf-btn"
              style={{ width: "100%", fontWeight: 600 }}
              onClick={onToggleMoveScenarioMode}
            >
              Move Scenario Mode {moveScenarioMode ? "ON" : "OFF"}
            </button>
            <div style={{ marginTop: 4, fontSize: 11, color: "#555", textAlign: "center" }}>
              Click rooms to add/remove them from a what-if scenario. Real data is not changed.
            </div>
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
}
