// src/surveyConfigs.js

// These are the questions for the STUDENT survey
const studentMarkerTypes = {
  'This is one of my go-to study spots': '#006400',
  'This is a go-to hangout spot for me and my friends': '#008000',
  'I would like to use this space more, but it needs improvement': '#9cdef1ff',
  'This space feels outdated or run-down': '#f4e806ff',
  'The furniture in this space is uncomfortable or not functional': '#e9a804ff',
  'The lighting or temperature in thei space makes it uncomfortable': '#f29008ff',
  'I rarely or never use this space': '#f05555ff',
  'I do not feel safe in this space': '#e00905bc',
  'Just leave a comment about this space': '#9E9E9E',
};

// These are the questions for the STAFF survey
const staffMarkerTypes = {
  'This space supports my teaching and/or professional work effectively': '#007330ff',
  'I wish this space were more flexible or adaptable for different uses': '#31f579ff',
  'I would like to use this space more, but it needs some improvement': '#94d2bd',
  'The layout or furniture is not functional for my needs': '#e9d8a6',
  'The technology in this space is enadequate or unreliable': '#f4d804ff',
  'This space lacks the provacy needed for my work': '#f97c3eff',
  'I rarely or never use this space': '#f25f54ff',
  'I do not feel safe in this space': '#ae2012',
  'Just leave a comment about this space': '#9E9E9E',
};

// We export them in a single object for easy access
export const surveyConfigs = {
  student: studentMarkerTypes,
  staff: staffMarkerTypes,
  // A default set in case the URL is wrong
  default: studentMarkerTypes, 
};