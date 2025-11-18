// src/components/panels/FloorPanel.jsx
import React from "react";
import { getDeptColor } from "../../style/roomColors";

export default function FloorPanel({
  buildingName,
  floorLabel,
  stats, // { totalSf, rooms, classroomSf, classroomCount }
  keyDepts = [], // [{ name, areaSf }]
  floors = [],
  selectedFloor,
  onChangeFloor,
  onLoadFloorplan,
  onClose,
}) {
  const area = (v) =>
    Number.isFinite(v) ? Math.round(v).toLocaleString() : "-";
  const count = (v) => (Number.isFinite(v) ? Number(v).toLocaleString() : "-");

  return (
    <div style={{ minWidth: 420, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700 }}>{buildingName}</div>
        <button onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
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
                <div style={{ flex: 1 }}>{d.name}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
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
      </div>
    </div>
  );
}
