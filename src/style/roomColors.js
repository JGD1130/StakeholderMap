// src/style/roomColors.js
// Single source of truth for department colors + helpers

// Known palette for every department the client listed.
// Any missing department gets a stable fallback from a hash palette.
export const DEPT_COLORS = {
  "Academic Support": "#f68a69",
  "Admissions": "#b3b3b3",
  "Admin-General": "#dcf4b4",
  "Alumni & Foundation": "#4CAF50",
  "Art": "#ea0ea0",
  "Athletics": "#ea550a",
  "Biology": "#17becf",
  "Bronco Blend": "#5a4b22",
  "Business Economics": "#d77cf8",
  "Business Office": "#C44E52",
  "Career Services": "#ff7f50",
  "Chaplain": "#7B7F9E",
  "Chemistry": "#f24516",
  "Classroom": "#c20583",
  "CFO": "#789051",
  "CIO": "#2282bd",
  "Communication": "#109014",
  "Creighton Coll of Nursing": "#76C7C0",
  "Digital Art": "#ffb347",
  "Esports": "#00B894",
  "Facilities": "#2CA02C",
  "Financial Aid": "#8C564B",
  "Forensics": "#aef2e1",
  "Health Center": "#f50909",
  "History, Religion, Philosophy": "#649515",
  "Housing": "#f54d4d",
  "HR": "#3498DB",
  "IR": "#3b580e",
  "IT": "#836377",
  "Languages & Literatures": "#4a64b9",
  "Library": "#079c29",
  "Maintenance & Facilities": "#a6a6a6",
  "Math": "#427b75",
  "Music": "#9467bd",
  "Offline": "#515250",
  "OMC": "#9273f7",
  "Open": "#95A5A6",
  "Physical Education": "#a6d854",
  "PM": "#d7a0fa",
  "President Office": "#d884d8",
  "Psychology": "#2bf087",
  "Registrar": "#F1C40F",
  "Service Learning/Chaplain": "#66c2a5",
  "Student Accounts": "#86e6ed",
  "Student Engagement": "#1584ed",
  "Student Union": "#7cb0ef",
  "Teacher Education": "#2E86AB",
  "Theatre": "#f1374c",
  "Unknown": "#8d776c",
  "VPAA": "#1568f9",
  "VPAA - Academic Admin": "#dde80d",
  "Physics": "#ff24ab"
};

const HASH_PALETTE = [
  "#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd",
  "#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function getDeptColor(name) {
  if (!name) return "#AAAAAA";
  const known = DEPT_COLORS[name];
  if (known) return known;
  const idx = hashStr(name) % HASH_PALETTE.length;
  return HASH_PALETTE[idx];
}

// For mapbox match expression if you need it elsewhere
export function DEPT_FILL_MATCH(deptProp = ["get","Department"]) {
  // build match expression: ["match", ["to-string", <prop>], "Dept A", "#hex", ... , "#fallback"]
  const flat = Object.entries(DEPT_COLORS).flat();
  return ["match", ["to-string", deptProp], ...flat, "#AAAAAA"];
}
