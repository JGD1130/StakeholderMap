// src/components/panels/BuildingPanel.jsx
import React from "react";
import { getDeptColor } from "../../style/roomColors";
import UtilizationBars from "../UtilizationBars";

export default function BuildingPanel({
  buildingName,
  stats, // { totalSf, rooms, classroomSf, classroomCount }
  keyDepts = [], // [{ name, areaSf }, ...] already sorted by area desc
  floors = [],
  selectedFloor,
  onChangeFloor,
  onLoadFloorplan,
  onClose,
  onExportPDF,
  onExportCSV,
  onExplainBuilding,
  explainBuildingLoading = false,
  explainBuildingDisabled = false,
  explainBuildingError = '',
  utilization,
  dragHandleProps,
}) {
  const area = (v) =>
    Number.isFinite(v) ? Math.round(v).toLocaleString() : "-";
  const count = (v) => (Number.isFinite(v) ? Number(v).toLocaleString() : "-");
  const isDraggable = Boolean(dragHandleProps);
  const { style: dragStyle, ...dragProps } = dragHandleProps || {};
  const showUtilization = utilization && (Number.isFinite(utilization.timeUtilization) || Number.isFinite(utilization.seatUtilization));
  const headerStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingRight: 6,
    ...(isDraggable ? { cursor: "grab", userSelect: "none", touchAction: "none" } : {}),
    ...(dragStyle || {})
  };

  return (
    <div style={{ minWidth: 320, maxWidth: 360, padding: 12, fontSize: 13 }}>
      <div style={headerStyle} {...dragProps}>
        <div style={{ fontWeight: 700 }}>{buildingName}</div>
        <button onClick={onClose} aria-label="Close" style={{ marginRight: 4 }}>
          &times;
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 8,
          marginTop: 8,
        }}
      >
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>BUILDING TOTALS</div>
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
            <div>
              <b>Levels:</b> {floors?.length ?? 0}
            </div>
          </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Key Departments</div>
          {keyDepts.length === 0 ? (
            <div style={{ color: "#666" }}>&mdash;</div>
          ) : (
            keyDepts.map((d) => (
              <div
                key={d.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                  fontSize: 12,
                  lineHeight: 1.25,
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    background: getDeptColor(d.name),
                    border: "1px solid #999",
                  }}
                />
                <div style={{ flex: 1 }}>
                  {d.name} {Number.isFinite(d.areaSf || d.Area || d.sf)
                    ? ` (${Math.round((d.areaSf || d.Area || d.sf)).toLocaleString()} SF)`
                    : ""}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showUtilization ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Classroom Utilization</div>
          <UtilizationBars
            timePct={utilization.timeUtilization}
            seatPct={utilization.seatUtilization}
            compact
          />
        </div>
      ) : null}

      <div
        style={{
          marginTop: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
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
        <button onClick={onExportPDF}>Export to PDF</button>
        <button onClick={onExportCSV}>Export CSV</button>
        <button
          onClick={onExplainBuilding}
          disabled={explainBuildingDisabled || explainBuildingLoading}
        >
          {explainBuildingLoading ? "Explaining..." : "✨ Explain this building"}
        </button>
      </div>
      {explainBuildingError ? (
        <div style={{ color: "crimson", marginTop: 6, fontSize: 12 }}>{explainBuildingError}</div>
      ) : null}
    </div>
  );
}
