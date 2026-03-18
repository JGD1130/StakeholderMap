import React, { useEffect, useState } from 'react';
import './BuildingInteractionPanel.css';

const BuildingInteractionPanel = ({
  buildingId,
  buildingName,
  currentCondition,
  onSave,
  onOpenTechnical,
  onClose,
  showTechnicalButton = true,
  floorplans,
  onSelectFloorplan
}) => {
  const [pendingCondition, setPendingCondition] = useState(currentCondition ?? '');

  useEffect(() => {
    setPendingCondition(currentCondition ?? '');
  }, [buildingId, currentCondition]);

  const handleSave = () => {
    if (!buildingId) return;
    if (!pendingCondition) return;
    onSave(buildingId, pendingCondition);
  };

  const dirty = (pendingCondition || '') !== (currentCondition || '');

  return (
    <div className="interaction-panel">
      <button className="close-button" onClick={onClose}>x</button>
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

      {showTechnicalButton && (
        <div className="button-row" style={{ marginTop: 8 }}>
          <button onClick={onOpenTechnical}>Technical Assessment</button>
        </div>
      )}

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
