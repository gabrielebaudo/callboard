'use strict';

/**
 * Parse a QLab cue name using the "[DEPARTMENT] Title" convention.
 * @param {string} name raw cue name
 * @returns {{department: string, title: string}}
 */
function parseMarkerName(name) {
  const raw = typeof name === 'string' ? name : '';
  const match = raw.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
  if (!match) {
    return {
      department: 'UNCATEGORIZED',
      title: raw.trim()
    };
  }

  return {
    department: match[1].trim().toUpperCase(),
    title: match[2].trim() || raw.trim()
  };
}

/**
 * Resolve a cue's department from its [DEPT] name prefix only. A prefix
 * that doesn't match one of the configured departments is treated as
 * UNCATEGORIZED rather than guessed at.
 *
 * @param {string} name raw cue name
 * @param {{departments?: Array<{key: string}>}} config app config
 * @returns {{department: string, title: string}}
 */
function resolveDepartment(name, config = {}) {
  const parsed = parseMarkerName(name);
  if (parsed.department === 'UNCATEGORIZED') return parsed;

  const knownDepartments = Array.isArray(config.departments)
    ? config.departments.map((d) => d.key.toUpperCase())
    : null;

  if (!knownDepartments || knownDepartments.includes(parsed.department)) {
    return parsed;
  }

  return { department: 'UNCATEGORIZED', title: parsed.title };
}

module.exports = { parseMarkerName, resolveDepartment };
