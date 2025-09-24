// src/components/BuildingInteractionPanel.jsx
import React, { useEffect, useState } from 'react';
import './BuildingInteractionPanel.css';

const BuildingInteractionPanel = ({
  buildingId,
  buildingName,
  currentCondition,
  onSave,              // (buildingId, newCondition)
  onOpenTechnical,     // opens the technical assessment panel
  onClose,             // closes this panel
  floorplans,          // optional [{ name, id }...] if you want quick floor links
  onSelectFloorplan    // optional (plan) => void
}) => {
  // Local, explicit edit state
  const [pendingCondition, setPendingCondition] = useState(currentCondition ?? '');

  // Keep local state in sync when selecting another building
  useEffect(() => {
    setPendingCondition(currentCondition ?? '');
  }, [buildingId, currentCondition]);

  const handleSave = () => {
    if (!buildingId) return;
    if (!pendingCondition) return; // no-op if not chosen
    onSave(buildingId, pendingCondition);
  };

  const dirty = (pendingCondition || '') !== (currentCondition || '');

  return (
    <div className="interaction-panel">
      <button className="close-button" onClick={onClose}>×</button>
      <h4>{buildingName || buildingId}</h4>

      <div className="control-section">
        <h5>Stakeholder Condition</h5>
        <select
          value={pendingCondition}
          onChange={(e) => setPendingCondition(e.target.value)}
        >
          <option value="" disabled>Select condition...</option>
          <option value="5">5 = Excellent</option>
          <option value="4">4 = Good</option>
          <option value="3">3 = Adequate</option>
          <option value="2">2 = Poor</option>
          <option value="1">1 = Very Poor</option>
        </select>

        <div className="button-row" style={{ marginTop: 8 }}>
          <button
            onClick={handleSave}
            disabled={!dirty || !pendingCondition}
          >
            Save Stakeholder Condition
          </button>
        </div>
      </div>

      <div className="button-row" style={{ marginTop: 8 }}>
        <button onClick={onOpenTechnical}>Technical Assessment</button>
      </div>

      {/* Optional: quick floor links */}
      {floorplans && floorplans.length > 0 && (
        <div className="control-section">
          <h5>Floor Plans</h5>
          <div className="floorplan-buttons">
            {floorplans.map((plan, i) => (
              <button key={i} onClick={() => onSelectFloorplan?.(plan)}>
                {plan.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default BuildingInteractionPanel;
