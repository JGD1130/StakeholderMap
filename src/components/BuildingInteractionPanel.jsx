import React, { useState } from 'react';
import { db } from '../firebaseConfig';
import { doc, setDoc } from 'firebase/firestore';
import './StakeholderMap.css'; // We can reuse some styles

const stakeholderConditionConfig = {
  '5': { label: '5 = Excellent condition' },
  '4': { label: '4 = Good condition' },
  '3': { label: '3 = Adequate condition' },
  '2': { label: '2 = Poor condition' },
  '1': { label: '1 = Very poor condition' }
};

const BuildingInteractionPanel = ({ buildingId, buildingName, currentCondition, onSave, onOpenTechnical, onClose }) => {
  const [selectedCondition, setSelectedCondition] = useState(currentCondition || '');

  const handleSaveCondition = async () => {
    if (!selectedCondition) {
      alert('Please select a condition before saving.');
      return;
    }
    try {
      // The document ID in Firestore is the buildingId, with slashes replaced
      const docId = buildingId.replace(/\//g, "__");
      await setDoc(doc(db, "buildingConditions", docId), { 
        condition: selectedCondition,
        originalId: buildingId // Store original ID for reference
      });
      alert(`Condition for ${buildingName} saved!`);
      onSave(buildingId, selectedCondition); // Tell the map to update its state
      onClose(); // Close the panel after saving
    } catch (error) {
      console.error("Error saving condition: ", error);
      alert("Failed to save condition. See console for details.");
    }
  };

  if (!buildingId) return null;

  return (
    <div className="interaction-panel">
      <div className="panel-header">
        <h4>{buildingName || buildingId}</h4>
        <button onClick={onClose} className="close-button">×</button>
      </div>
      <div className="panel-content">
        <div className="condition-section">
          <label htmlFor="condition-select">Set Stakeholder Condition:</label>
          <select 
            id="condition-select" 
            value={selectedCondition} 
            onChange={(e) => setSelectedCondition(e.target.value)}
          >
            <option value="" disabled>Select a condition...</option>
            {Object.entries(stakeholderConditionConfig).reverse().map(([value, { label }]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <button onClick={handleSaveCondition}>Save Condition</button>
        </div>
        <hr />
        <div className="assessment-section">
          <p>Or perform a detailed review:</p>
          <button onClick={onOpenTechnical}>Open Technical Assessment</button>
        </div>
      </div>
    </div>
  );
};

export default BuildingInteractionPanel;