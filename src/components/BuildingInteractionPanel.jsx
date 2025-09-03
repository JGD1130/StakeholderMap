// src/components/BuildingInteractionPanel.jsx
import React from 'react';
import './BuildingInteractionPanel.css';

// --- UPDATED ---
// The component now accepts `floorplans` and an `onSelectFloorplan` function.
const BuildingInteractionPanel = ({
  buildingId,
  buildingName,
  currentCondition,
  onSave,
  onOpenTechnical,
  onClose,
  floorplans,
  onSelectFloorplan
}) => {
  const handleConditionChange = (event) => {
    onSave(buildingId, event.target.value);
  };

  return (
    <div className="interaction-panel">
      <button className="close-button" onClick={onClose}>×</button>
      <h4>{buildingName || buildingId}</h4>
      
      <div className="control-section">
        <h5>Stakeholder Condition</h5>
        <select value={currentCondition || ''} onChange={handleConditionChange}>
          <option value="" disabled>Select condition...</option>
          <option value="5">5 = Excellent</option>
          <option value="4">4 = Good</option>
          <option value="3">3 = Adequate</option>
          <option value="2">2 = Poor</option>
          <option value="1">1 = Very Poor</option>
        </select>
      </div>

      <div className="button-row">
        <button onClick={onOpenTechnical}>Technical Assessment</button>
      </div>

      {/* --- THIS IS THE NEW SECTION --- */}
      {/* If floorplans exist, show this section */}
      {floorplans && floorplans.length > 0 && (
        <div className="control-section">
          <h5>Floor Plans</h5>
          <div className="floorplan-buttons">
            {floorplans.map((plan, index) => (
              <button key={index} onClick={() => onSelectFloorplan(plan)}>
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