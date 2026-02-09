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
  rotateActive = false,
  moveActive = false,
  rotateValue = 0,
  scaleValue = 1,
  rotateNotice = '',
  rotateStored = false,
  adjustDebugInfo = null,
  onStartRotate,
  onStartMove,
  onCancelRotate,
  onClearRotate,
  onScaleChange,
  onSaveAdjust,
  saveAdjustDisabled = false,
  dragHandleProps,
}) {
  const area = (v) =>
    Number.isFinite(v) ? Math.round(v).toLocaleString() : "-";
  const count = (v) => (Number.isFinite(v) ? Number(v).toLocaleString() : "-");
  const isDraggable = Boolean(dragHandleProps);
  const { style: dragStyle, ...dragProps } = dragHandleProps || {};
  const headerStyle = {
    display: "flex",
    justifyContent: "space-between",
    ...(isDraggable ? { cursor: "grab", userSelect: "none", touchAction: "none" } : {}),
    ...(dragStyle || {})
  };

  return (
    <div style={{ minWidth: 340, maxWidth: 380, padding: 12, fontSize: 13 }}>
      <div style={headerStyle} {...dragProps}>
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
          <button className="btn primary" onClick={onLoadFloorplan}>Load</button>
          {onUnloadFloorplan ? <button className="btn" onClick={onUnloadFloorplan}>Unload</button> : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <button className="btn secondary" onClick={onExportPDF}>Export to PDF</button>
          {onExportCSV ? <button className="btn" onClick={onExportCSV}>Export CSV</button> : null}
          <button
            className="btn"
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
              { key: 'occupancy', label: 'Occupancy' }
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
              className="btn"
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
        {onStartRotate ? (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #e5e5e5" }}>
            <div style={{ fontWeight: 600 }}>Adjust Floorplan</div>
            <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>
              {rotateActive || moveActive
                ? "Drag on the map. Release to save."
                : "Use Rotate or Move, then drag on the map to adjust rooms + linework together."}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              Rotation: {Number.isFinite(rotateValue) ? `${rotateValue.toFixed(1)}°` : "0°"} ·
              Scale: {Number.isFinite(scaleValue) ? scaleValue.toFixed(2) : "1.00"}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              <button className="btn" onClick={rotateActive ? onCancelRotate : onStartRotate}>
                {rotateActive ? "Cancel Rotate" : "Rotate"}
              </button>
              {onStartMove ? (
                <button className="btn" onClick={moveActive ? onCancelRotate : onStartMove}>
                  {moveActive ? "Cancel Move" : "Move"}
                </button>
              ) : null}
              {onScaleChange ? (
                <>
                  <button className="btn" onClick={() => onScaleChange(-0.02)}>- Scale</button>
                  <button className="btn" onClick={() => onScaleChange(0.02)}>+ Scale</button>
                </>
              ) : null}
              {onSaveAdjust ? (
                <button className="btn primary" onClick={onSaveAdjust} disabled={saveAdjustDisabled}>
                  Save Adjust
                </button>
              ) : null}
              {onClearRotate ? (
                <button className="btn" onClick={onClearRotate} disabled={!rotateStored}>
                  Clear Adjust
                </button>
              ) : null}
            </div>
            {rotateNotice ? (
              <div style={{ color: "crimson", fontSize: 12, marginTop: 4 }}>
                {rotateNotice}
              </div>
            ) : null}
            {adjustDebugInfo ? (
              <div style={{ fontSize: 11, color: "#666", marginTop: 6 }}>
                <div style={{ fontWeight: 600 }}>Adjust debug</div>
                <div>source: {adjustDebugInfo.source || '-'}</div>
                <div>labelKey: {adjustDebugInfo.labelKey || '-'}</div>
                <div>baseKey: {adjustDebugInfo.baseKey || '-'}</div>
                <div>urlKey: {adjustDebugInfo.urlKey || '-'}</div>
                <div>floorId: {adjustDebugInfo.floorId || '-'}</div>
                <div>savedAt: {adjustDebugInfo.savedAt ? new Date(adjustDebugInfo.savedAt).toLocaleTimeString() : '-'}</div>
                <div>rot: {Number.isFinite(adjustDebugInfo.rotationDeg) ? adjustDebugInfo.rotationDeg.toFixed(2) : '0'}</div>
                <div>scale: {Number.isFinite(adjustDebugInfo.scale) ? adjustDebugInfo.scale.toFixed(3) : '1.000'}</div>
                <div>move: {Array.isArray(adjustDebugInfo.translateMeters) ? `${adjustDebugInfo.translateMeters[0].toFixed(2)}, ${adjustDebugInfo.translateMeters[1].toFixed(2)}` : '0, 0'}</div>
                <div>moveLngLat: {Array.isArray(adjustDebugInfo.translateLngLat) ? `${adjustDebugInfo.translateLngLat[0].toFixed(6)}, ${adjustDebugInfo.translateLngLat[1].toFixed(6)}` : '-'}</div>
                <div>pivot: {Array.isArray(adjustDebugInfo.pivot) ? `${adjustDebugInfo.pivot[0].toFixed(6)}, ${adjustDebugInfo.pivot[1].toFixed(6)}` : '-'}</div>
                {Array.isArray(adjustDebugInfo.storedKeys) && adjustDebugInfo.storedKeys.length ? (
                  <div style={{ marginTop: 4 }}>
                    keys: {adjustDebugInfo.storedKeys.slice(0, 3).join(' | ')}
                    {adjustDebugInfo.storedKeys.length > 3 ? ` +${adjustDebugInfo.storedKeys.length - 3} more` : ''}
                  </div>
                ) : (
                  <div style={{ marginTop: 4 }}>keys: none</div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
}
