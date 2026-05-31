import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalize,
  graphIdForProject,
  graphIdForAgent,
  graphIdForTask,
  graphIdForScope,
  listScopesPrefix,
} from './normalize.js';

describe('normalize()', () => {
  const cases: Array<[string, string, string]> = [
    // [name, input, expected]
    ['lowercases ASCII', 'PROJECT-X', 'project-x'],
    ['preserves digits and underscores', 'abc_123-XYZ', 'abc_123-xyz'],
    ['replaces invalid chars with -', 'hello world!?', 'hello-world'],
    ['collapses multiple dashes', 'a----b', 'a-b'],
    ['collapses dashes from punctuation runs', 'a@@@b', 'a-b'],
    ['trims leading dashes', '---hello', 'hello'],
    ['trims trailing dashes', 'hello---', 'hello'],
    ['trims both ends', '---hello---', 'hello'],
    ['handles spaces', 'project alpha beta', 'project-alpha-beta'],
    ['handles unicode by replacing', 'café-😀-end', 'caf-end'],
    ['truncates to 64 chars', 'a'.repeat(100), 'a'.repeat(64)],
    ['truncates after normalization', `${'a'.repeat(70)}!!!`, 'a'.repeat(64)],
    ['handles empty string via sha256 fallback', '', expectedHashFallback('')],
    ['handles all-invalid input via sha256 fallback', '!!!@@@###', expectedHashFallback('!!!@@@###')],
    ['handles whitespace-only via sha256 fallback', '   ', expectedHashFallback('   ')],
    ['handles just dashes via sha256 fallback', '---', expectedHashFallback('---')],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(normalize(input)).toBe(expected);
    });
  }

  it('produces distinguishable hashes for different all-invalid inputs', () => {
    // Both inputs would collapse to "" before the hash fallback, so the fallback
    // MUST use the original (non-empty) bytes to disambiguate them.
    expect(normalize('!!!')).not.toBe(normalize('@@@'));
  });

  it('is idempotent on already-normal input', () => {
    const out = normalize('alpha-beta_gamma-123');
    expect(out).toBe('alpha-beta_gamma-123');
    expect(normalize(out)).toBe(out);
  });

  it('only emits characters in [a-z0-9_-]', () => {
    const inputs = [
      'Hello, World!',
      'CAFE-7',
      'task_id::42',
      'project/with/slashes',
      'name with spaces',
      '混合 latin 文字',
    ];
    for (const input of inputs) {
      const out = normalize(input);
      expect(out).toMatch(/^[a-z0-9_-]+$/);
      expect(out.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('graphId mapping', () => {
  it('builds project-wide graphId', () => {
    expect(graphIdForProject('MyProj')).toBe('proj_myproj');
  });

  it('builds per-agent graphId', () => {
    expect(graphIdForAgent('MyProj', 'Researcher-1')).toBe('proj_myproj__agent_researcher-1');
  });

  it('builds per-task graphId', () => {
    expect(graphIdForTask('MyProj', 'Researcher-1', 'TASK-42')).toBe(
      'proj_myproj__agent_researcher-1__task_task-42',
    );
  });

  it('routes scope to the correct level', () => {
    expect(graphIdForScope({ project_id: 'P' })).toBe('proj_p');
    expect(graphIdForScope({ project_id: 'P', agent_id: 'A' })).toBe('proj_p__agent_a');
    expect(graphIdForScope({ project_id: 'P', agent_id: 'A', task_id: 'T' })).toBe(
      'proj_p__agent_a__task_t',
    );
  });

  it('treats null/undefined/empty agent_id as project-level', () => {
    expect(graphIdForScope({ project_id: 'P', agent_id: null })).toBe('proj_p');
    expect(graphIdForScope({ project_id: 'P', agent_id: '' })).toBe('proj_p');
    expect(graphIdForScope({ project_id: 'P', agent_id: undefined })).toBe('proj_p');
  });

  it('rejects task_id without agent_id', () => {
    expect(() => graphIdForScope({ project_id: 'P', task_id: 'T' })).toThrow(/task_id requires/);
  });

  it('rejects missing project_id', () => {
    expect(() => graphIdForScope({ project_id: '' })).toThrow(/project_id is required/);
  });

  it('survives prefix-collision aggressors', () => {
    // Two different inputs that would collide on a naive prefix scheme but
    // are distinguishable because of the `_` and `__` separators.
    const a = graphIdForAgent('proj', 'a__agent_b');
    const b = graphIdForAgent('proj-a', 'agent_b');
    expect(a).not.toBe(b);
  });

  it('list_scopes prefix matches graphId for the project', () => {
    // CRITICAL: list_scopes filter MUST use the same normalized prefix as the
    // graphId construction — otherwise a "Project With Spaces" id would never
    // match.
    const projectId = 'Project With Spaces!';
    const projectGraph = graphIdForProject(projectId);
    const prefix = listScopesPrefix(projectId);
    expect(projectGraph).toBe(prefix);
    expect(prefix).toBe('proj_project-with-spaces');

    // Per-agent and per-task graphIds also start with the same prefix.
    const agentGraph = graphIdForAgent(projectId, 'researcher');
    const taskGraph = graphIdForTask(projectId, 'researcher', 'TASK-1');
    expect(agentGraph.startsWith(prefix)).toBe(true);
    expect(taskGraph.startsWith(prefix)).toBe(true);
  });
});

function expectedHashFallback(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
