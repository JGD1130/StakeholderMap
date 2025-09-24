import React, { useState, useEffect } from 'react';
import './AssessmentPanel.css';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebaseConfig';

const scoreOptions = [
{ value: 5, label: '5 - Excellent' },
{ value: 4, label: '4 - Good' },
{ value: 3, label: '3 - Adequate' },
{ value: 2, label: '2 - Poor' },
{ value: 1, label: '1 - Very Poor' },
{ value: 0, label: '0 - Not Set' },
];

const assessmentTemplate = {
buildingName: '',
notes: '',
scores: {
architecture: { exterior: 0, entrances: 0, interiorFinishes: 0, lifeSafety: 0, codesAndAccessibility: 0 },
engineering: { superstructure: 0, conveyingSystems: 0, fireProtection: 0, plumbing: 0, mechanical: 0, power: 0, lighting: 0 },
functionality: { telecomm: 0, fireAlarm: 0, spaceSize: 0, technology: 0 },
},
};

const AssessmentPanel = ({ buildingId, assessments, onClose, onSave, universityId, panelPos }) => {
const [localAssessment, setLocalAssessment] = useState(assessmentTemplate);

useEffect(() => {
if (buildingId && assessments) {
const current = assessments[buildingId] || { ...assessmentTemplate, buildingName: buildingId };
setLocalAssessment(current);
}
}, [buildingId, assessments]);

const handleScoreChange = (category, subCategory, value) => {
setLocalAssessment(prev => ({
...prev,
scores: { ...prev.scores, [category]: { ...prev.scores[category], [subCategory]: Number(value) } },
}));
};

const handleNotesChange = (e) => {
setLocalAssessment(prev => ({ ...prev, notes: e.target.value }));
};

const handleSaveChanges = async () => {
if (!buildingId || !universityId) return;
const sanitizedId = buildingId.replace(/\//g, '__');
const ref = doc(db, 'universities', universityId, 'buildingAssessments', sanitizedId);
const dataToSave = { ...localAssessment, originalId: buildingId };

try {
  await setDoc(ref, dataToSave);
  onSave(dataToSave);
  alert('Assessment saved successfully!');
  onClose();
} catch (err) {
  console.error('Error saving assessment:', err);
  alert('Failed to save assessment. See console for details.');
}
};

if (!buildingId) return null;

const containerStyle = panelPos
? { position: 'absolute', left: (panelPos.x ?? 80), top: (panelPos.y ?? 160), zIndex: 6 }
: undefined;

return (
<div className="assessment-panel" style={containerStyle}>
<div className="panel-header">
<h3>Technical Assessment</h3>
<button onClick={onClose} className="close-button">×</button>
</div>
<div className="panel-content">
<h4>{localAssessment.buildingName || buildingId}</h4>

    {localAssessment.scores && Object.entries(localAssessment.scores).map(([category, subScores]) => (
      <div key={category} className="category-section">
        <h5>{category.charAt(0).toUpperCase() + category.slice(1)}</h5>
        {Object.entries(subScores).map(([subCategory, score]) => (
          <div key={subCategory} className="score-item">
            <label>{subCategory.replace(/([A-Z])/g, ' $1').trim()}</label>
            <select value={score} onChange={(e) => handleScoreChange(category, subCategory, e.target.value)}>
              {scoreOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
        ))}
      </div>
    ))}

    <div className="notes-section">
      <h5>Notes</h5>
      <textarea value={localAssessment.notes || ''} onChange={handleNotesChange} rows="4" />
    </div>

    <button className="save-button" onClick={handleSaveChanges}>Save Changes</button>
  </div>
</div>
);
};

export default AssessmentPanel;
