import { readFileSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The in-repo skill library: on-disk format, progressive-disclosure loader, and the scanners the
 * approval card runs over a procedure the agent proposes.
 *
 * Nothing here installs anything. The built-in library is checked into the repository; a workspace
 * skill is written only through `skill(action=upsert)`, which shows the owner the whole proposed
 * body and saves nothing until they approve it.
 *
 * This file used to carry a second, larger half: an induction, evaluation and retirement lifecycle
 * for agent-authored skills - proposal review against trace attestation, reliability scoring,
 * probation and archival. None of it was ever reachable. The `skill` tool takes a name, a
 * description and a body and nothing else, so there were no episodes to attest against, no trials
 * to score and no caller anywhere in the worker, the API or the web client. It has been removed
 * rather than left looking like a control that runs, and `skills/skill-authoring` now describes the
 * gate that does exist. The design it implemented is still written up in docs/design/skill-library.md.
 *
 * Its last survivor was a `SKILL_LIFECYCLE` table of promotion, probation and retirement thresholds
 * that nothing read. A tuned-looking constant is the most convincing thing a dead control can leave
 * behind, so it is gone too. What is real is in the store: `curateWorkspaceSkills` marks a skill
 * stale at thirty days unused and archived at ninety, and a pinned one is exempt.
 *
 * A `searchSkills` BM25 ranker over name, description and the sidecar's positive trigger phrases
 * went the same way, and for the same reason: the `skill` tool offers list, view, upsert and remove,
 * so no model could ever call it. Selection is the resident catalog plus the instruction to open a
 * skill before doing the work it covers, which is the only mechanism that was ever wired. The
 * `triggers` block went out of the sidecars with it rather than being left one layer down, where a
 * skill author would reasonably read it as the thing that decides when their skill is chosen.
 */

// ---------------------------------------------------------------------------
// Minimal YAML subset
// ---------------------------------------------------------------------------

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export class SkillFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFormatError';
  }
}

interface YamlLine {
  readonly indent: number;
  readonly text: string;
}

const yamlLines = (source: string): YamlLine[] => {
  const lines: YamlLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (raw.slice(0, indent).includes('\t'))
      throw new SkillFormatError(`tab indentation is not valid YAML: ${trimmed}`);
    lines.push({ indent, text: trimmed });
  }
  return lines;
};

/** Index of the `:` that separates a mapping key from its value, ignoring quotes and flow spans. */
const keySeparator = (text: string): number => {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    else if (character === ':' && depth === 0) {
      const next = text[index + 1];
      if (next === undefined || next === ' ') return index;
    }
  }
  return -1;
};

const stripTrailingComment = (value: string): string => {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    else if (character === '#' && depth === 0 && (index === 0 || /\s/.test(value[index - 1] ?? '')))
      return value.slice(0, index).trim();
  }
  return value.trim();
};

const splitFlow = (inner: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const character of inner) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

const closingIndex = (value: string, open: string, close: string): number => {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const parseScalar = (raw: string): YamlValue => {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("'") || value.startsWith('"')) {
    const quote = value[0] ?? "'";
    let index = 1;
    let text = '';
    while (index < value.length) {
      const character = value[index] ?? '';
      if (character === '\\' && quote === '"') {
        text += value[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          text += "'";
          index += 2;
          continue;
        }
        return text;
      }
      text += character;
      index += 1;
    }
    throw new SkillFormatError(`unterminated quoted scalar: ${value}`);
  }
  if (value.startsWith('[')) {
    const end = closingIndex(value, '[', ']');
    if (end < 0) throw new SkillFormatError(`unterminated flow sequence: ${value}`);
    return splitFlow(value.slice(1, end)).map((part) => parseScalar(part));
  }
  if (value.startsWith('{')) {
    const end = closingIndex(value, '{', '}');
    if (end < 0) throw new SkillFormatError(`unterminated flow mapping: ${value}`);
    const map: Record<string, YamlValue> = {};
    for (const entry of splitFlow(value.slice(1, end))) {
      const separator = keySeparator(entry);
      if (separator < 0)
        throw new SkillFormatError(`expected "key: value" in flow mapping: ${entry}`);
      map[parseKey(entry.slice(0, separator))] = parseScalar(entry.slice(separator + 1));
    }
    return map;
  }
  const bare = stripTrailingComment(value);
  if (bare === 'null' || bare === '~' || bare === '') return null;
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (/^-?\d+$/.test(bare) || /^-?\d+\.\d+$/.test(bare)) return Number(bare);
  return bare;
};

/** Mapping keys are always scalars; quoting is allowed but structure is not. */
const parseKey = (raw: string): string => {
  const value = parseScalar(raw);
  if (value === null || typeof value === 'object')
    throw new SkillFormatError(`mapping keys must be scalars, got: ${raw}`);
  return String(value);
};

const isBalanced = (value: string): boolean => {
  let depth = 0;
  let quote: string | null = null;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
  }
  return depth === 0;
};

/**
 * Joins a flow collection that a formatter has wrapped across several lines. Prettier reflows any
 * inline list past its print width, so a loader that only accepted single-line flow sequences would
 * break the moment the repository is formatted.
 */
const joinFlow = (lines: YamlLine[], start: number, initial: string): [string, number] => {
  let text = initial;
  let index = start;
  while (!isBalanced(text) && index < lines.length) {
    text = `${text} ${lines[index]?.text ?? ''}`;
    index += 1;
  }
  if (!isBalanced(text)) throw new SkillFormatError(`unterminated flow collection: ${initial}`);
  return [text, index];
};

const startsFlow = (value: string): boolean => value.startsWith('[') || value.startsWith('{');

const parseBlock = (lines: YamlLine[], start: number, indent: number): [YamlValue, number] => {
  const first = lines[start];
  if (!first) return [null, start];
  if (first.text === '-' || first.text.startsWith('- ')) return parseSequence(lines, start, indent);
  if (startsFlow(first.text)) {
    const [text, next] = joinFlow(lines, start + 1, first.text);
    return [parseScalar(text), next];
  }
  return parseMapping(lines, start, indent);
};

const parseMapping = (lines: YamlLine[], start: number, indent: number): [YamlValue, number] => {
  const map: Record<string, YamlValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent < indent) break;
    if (line.indent > indent) throw new SkillFormatError(`unexpected indentation at: ${line.text}`);
    if (line.text === '-' || line.text.startsWith('- ')) break;
    const separator = keySeparator(line.text);
    if (separator < 0) throw new SkillFormatError(`expected "key: value" at: ${line.text}`);
    const key = parseKey(line.text.slice(0, separator));
    const rest = line.text.slice(separator + 1).trim();
    index += 1;
    if (rest) {
      if (startsFlow(rest) && !isBalanced(rest)) {
        const [text, next] = joinFlow(lines, index, rest);
        map[key] = parseScalar(text);
        index = next;
        continue;
      }
      map[key] = parseScalar(rest);
      continue;
    }
    const next = lines[index];
    if (next && next.indent > indent) {
      const [value, nextIndex] = parseBlock(lines, index, next.indent);
      map[key] = value;
      index = nextIndex;
      continue;
    }
    map[key] = null;
  }
  return [map, index];
};

const parseSequence = (lines: YamlLine[], start: number, indent: number): [YamlValue, number] => {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent < indent) break;
    if (line.indent > indent) throw new SkillFormatError(`unexpected indentation at: ${line.text}`);
    if (line.text !== '-' && !line.text.startsWith('- ')) break;
    const afterDash = line.text.slice(1);
    const rest = afterDash.trim();
    // A block sequence item behaves like a block starting at the column where its content begins,
    // which is what makes `- run: x` / `  assert: y` parse as one mapping instead of two entries.
    const restIndent = line.indent + 1 + (afterDash.length - afterDash.trimStart().length);
    index += 1;
    const children: YamlLine[] = [];
    while (index < lines.length) {
      const child = lines[index];
      if (!child || child.indent <= line.indent) break;
      children.push(child);
      index += 1;
    }
    if (!rest) {
      if (!children.length) {
        items.push(null);
        continue;
      }
      const [value] = parseBlock(children, 0, children[0]?.indent ?? restIndent);
      items.push(value);
      continue;
    }
    if (startsFlow(rest) && !isBalanced(rest)) {
      items.push(parseScalar(joinFlow(children, 0, rest)[0]));
      continue;
    }
    if (keySeparator(rest) >= 0) {
      const [value] = parseMapping(
        [{ indent: restIndent, text: rest }, ...children],
        0,
        restIndent
      );
      items.push(value);
      continue;
    }
    items.push(parseScalar(rest));
  }
  return [items, index];
};

/**
 * Quoting pass applied once when a document fails to parse. An unquoted scalar containing `: ` is
 * the standard cross-client YAML failure in skill files, so recovering from it keeps a good skill
 * loadable instead of silently dropping it.
 */
export const quoteColonScalars = (source: string): string =>
  source
    .split(/\r?\n/)
    .map((raw) => {
      const match = /^(\s*(?:-\s+)?[A-Za-z0-9_.$-]+:\s+)(.*)$/.exec(raw);
      if (!match) return raw;
      const value = match[2] ?? '';
      if (!value || value.startsWith("'") || value.startsWith('"') || value.startsWith('['))
        return raw;
      if (value.startsWith('{') || !value.includes(': ')) return raw;
      return `${match[1]}'${value.replaceAll("'", "''")}'`;
    })
    .join('\n');

export const parseSkillYaml = (source: string): Record<string, YamlValue> => {
  const attempt = (text: string): Record<string, YamlValue> => {
    const lines = yamlLines(text);
    if (!lines.length) return {};
    const [value] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new SkillFormatError('expected a mapping at the document root');
    return value;
  };
  try {
    return attempt(source);
  } catch {
    return attempt(quoteColonScalars(source));
  }
};

export const parseSkillFrontMatter = (
  source: string
): { data: Record<string, YamlValue>; body: string } => {
  const normalized = source.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---')
    throw new SkillFormatError('SKILL.md must open with a --- front matter fence');
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close < 0) throw new SkillFormatError('SKILL.md front matter is not closed');
  return {
    data: parseSkillYaml(lines.slice(1, close).join('\n')),
    body: lines
      .slice(close + 1)
      .join('\n')
      .trim()
  };
};

// ---------------------------------------------------------------------------
// Skill model
// ---------------------------------------------------------------------------

export type SkillOrigin = 'builtin' | 'learned' | 'owner';
export type SkillSpend = 'none' | 'metered' | 'approval';

export interface SkillCapabilityGrant {
  readonly fsRead: readonly string[];
  readonly fsWrite: readonly string[];
  readonly netHosts: readonly string[];
  readonly exec: readonly string[];
  readonly connectors: readonly string[];
  readonly spend: SkillSpend;
}

export interface SkillVerifyStep {
  readonly run: string | null;
  readonly assert: string | null;
  readonly check: string | null;
}

export interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  readonly catalogLine: string;
  readonly body: string;
  readonly directory: string;
  readonly version: string;
  readonly origin: SkillOrigin;
  readonly risk: string;
  readonly domain: string;
  readonly allowedTools: readonly string[];
  readonly requiredTools: readonly string[];
  readonly requiredBinaries: readonly string[];
  readonly capability: SkillCapabilityGrant;
  readonly verify: readonly SkillVerifyStep[];
  readonly provenance: string | null;
  readonly bodyLines: number;
  readonly bodyTokens: number;
}

export interface SkillDiagnostic {
  readonly skill: string;
  readonly level: 'warn' | 'error';
  readonly code: string;
  readonly message: string;
}

export interface SkillLibrary {
  readonly root: string;
  readonly skills: readonly LoadedSkill[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

/**
 * The sections a workspace skill body must carry, in the spelling the upsert checks for.
 *
 * Declared here rather than inside the tool handler because the `skill-authoring` procedure has to
 * teach the same four names: it shipped for two waves telling the model to write Routing, Workflow,
 * Semantics, Attachments and Gotchas, none of which this accepts, so every skill the model tried to
 * save was rejected outright. The library test holds the shipped procedure against this list.
 */
export const SKILL_BODY_HEADINGS = [
  'When to use',
  'Procedure',
  'Pitfalls',
  'Verification'
] as const;

export const SKILL_BUDGET = {
  maxBodyLines: 500,
  maxBodyTokens: 5_000,
  maxCatalogWords: 20,
  maxDescriptionCharacters: 1_024,
  maxSkills: 96
} as const;

/** Cheap deterministic token estimate; the budget only needs to catch runaway bodies. */
export const estimateSkillTokens = (text: string): number => Math.ceil(text.length / 4);

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidSkillName = (name: string): boolean =>
  SKILL_NAME_PATTERN.test(name) &&
  name.length <= 64 &&
  !name.includes('anthropic') &&
  !name.includes('claude');

const stringList = (value: YamlValue): string[] => {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
};

const mapping = (value: YamlValue): Record<string, YamlValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const text = (value: YamlValue, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;

const spendValue = (value: YamlValue): SkillSpend =>
  value === 'metered' || value === 'approval' ? value : 'none';

const capabilityFrom = (value: YamlValue): SkillCapabilityGrant => {
  const record = mapping(value);
  return {
    fsRead: stringList(record['fs.read'] ?? null),
    fsWrite: stringList(record['fs.write'] ?? null),
    netHosts: stringList(record['net.hosts'] ?? null),
    exec: stringList(record.exec ?? null),
    connectors: stringList(record.connectors ?? null),
    spend: spendValue(record.spend ?? null)
  };
};

const verifyFrom = (value: YamlValue): SkillVerifyStep[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = mapping(entry);
    const render = record.render ? mapping(record.render) : null;
    const vision = record.vision ? mapping(record.vision) : null;
    const checks = [
      text(record.check ?? null) || null,
      render
        ? `render ${text(render.source ?? null, 'the artifact')} at ${text(render.dpi ?? null, '120')} dpi`
        : null,
      vision ? stringList(vision.must ?? null).join('; ') || 'vision rubric review' : null
    ].filter((item): item is string => Boolean(item));
    return {
      run: text(record.run ?? null) || null,
      assert: text(record.assert ?? null) || null,
      check: checks.length ? checks.join(' / ') : null
    };
  });
};

/**
 * Origin ceilings. A learned skill may only ever ask for what its source trajectory used, so the
 * open-ended grants below are refused outright rather than surfaced to the owner as a judgement
 * call buried in otherwise reasonable prose.
 */
const capabilityCeilingViolations = (
  origin: SkillOrigin,
  capability: SkillCapabilityGrant
): string[] => {
  if (origin === 'builtin') return [];
  const violations: string[] = [];
  if (capability.netHosts.includes('*'))
    violations.push('capability.net.hosts may not be "*" outside the built-in library');
  if (capability.spend === 'metered')
    violations.push('capability.spend: metered is reserved for the built-in library');
  if (
    capability.fsWrite.some(
      (pattern) => !pattern.startsWith('$WORKSPACE') && !pattern.startsWith('$TMP')
    )
  )
    violations.push('capability.fs.write must stay inside $WORKSPACE or $TMP');
  return violations;
};

const catalogWords = (line: string): number => line.trim().split(/\s+/).filter(Boolean).length;

const firstSentence = (description: string): string => {
  const match = /^(.*?[.!?])(\s|$)/.exec(description.trim());
  return (match?.[1] ?? description).trim();
};

/*
 * There was a `listResources` here, and an `<skill_resources>` block in every opened skill built
 * from it. Both are gone, and the decision is worth recording because the other arm was tried
 * first.
 *
 * What it did: scanned `scripts/`, `references/`, `assets/` and `evals/` under the skill directory
 * and advertised every entry to the model as `<file>scripts/count_error_cells.py</file>`. Two
 * things were wrong with that, and only one of them was fixable here.
 *
 * The small one: it did not filter, so a box where the script had been run once emitted
 * `<file>scripts/__pycache__</file>` - a directory of compiled bytecode offered as a resource, and
 * an opened-skill block whose bytes changed the first time anyone ran anything (ATH-228).
 *
 * The one that decided it: no tool the model holds can read any of those paths, and none can be
 * made to without moving the workspace boundary. `openSkill` is reachable only for on-disk skills
 * (a workspace skill is a database row, opened at `agent.ts` from the store), so `skill.directory`
 * is always a folder under a root the operator chose - `DEFAULT_SKILL_ROOT`, or one of the owner's
 * own roots (see `ownerSkillRoots`) - and never inside any workspace. `file_read` is answered by the runner, a separate service whose `WORKSPACE_ROOT` is
 * a different tree entirely, and every one of its file routes goes through
 * `assertUserDataPath` (`services/workspace-runner/src/files.ts`), which admits `workspace/` and
 * `.garden/artifacts/` and refuses everything else by design. Wiring `OpenedSkill.allowlist` into
 * that layer as a read-only exemption would mean teaching the file boundary a second root, sending
 * it across the worker/runner API on every read, and doing it on the one function whose entire job
 * is to say no - to make a handful of shipped scripts readable that the model does not need to
 * read. So the advertisement went instead: the model was being shown a list of files and told, two
 * lines above in the same block, an absolute directory that answers `Path escapes workspace` when
 * it tries one (ATH-116).
 *
 * Nothing is lost. A skill's scripts are meant to be *run*, not read, and running them still works:
 * the agent sandbox is a Unix-account drop rather than a mount namespace, so a command can name a
 * path under the skill directory and the interpreter opens it. What that needs is for the model to
 * know how to build the path, which is what the two sentences in the block below now say - and
 * they say it for every skill, including ones written after this comment, which an enumeration of
 * four hard-coded folder names never could.
 */

export const DEFAULT_SKILL_ROOT = fileURLToPath(new URL('../../../skills/', import.meta.url));

const loadOne = (
  root: string,
  name: string,
  diagnostics: SkillDiagnostic[],
  /**
   * The origin this root confers, when the root is the answer rather than the file.
   *
   * Everything below reads the skill's own declaration, which is right for a library that ships
   * inside garden and wrong for one the owner points at: `capabilityCeilingViolations` gives
   * `builtin` an unrestricted net grant, `spend: metered`, and writes outside the workspace, and
   * the declaration it reads is a line in the skill's own sidecar. A directory that can be dropped
   * into a watched folder could therefore write itself the ceiling by declaring it. Where the
   * origin is a fact about where the folder is, it is passed in and the declaration is ignored.
   */
  forcedOrigin?: SkillOrigin
): LoadedSkill | null => {
  const directory = join(root, name);
  let source: string;
  try {
    source = readFileSync(join(directory, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  let front: { data: Record<string, YamlValue>; body: string };
  try {
    front = parseSkillFrontMatter(source);
  } catch (error) {
    diagnostics.push({
      skill: name,
      level: 'error',
      code: 'front_matter_unparseable',
      message: error instanceof Error ? error.message : 'unreadable front matter'
    });
    return null;
  }
  const declaredName = text(front.data.name ?? null, name);
  const description = text(front.data.description ?? null).trim();
  if (!description) {
    diagnostics.push({
      skill: name,
      level: 'error',
      code: 'description_missing',
      message: 'a skill without a description can never be selected, so it is not loaded'
    });
    return null;
  }
  if (!isValidSkillName(declaredName))
    diagnostics.push({
      skill: name,
      level: 'warn',
      code: 'name_invalid',
      message: `"${declaredName}" is not a legal skill name; the directory name is used instead`
    });
  if (declaredName !== name && isValidSkillName(declaredName))
    diagnostics.push({
      skill: name,
      level: 'warn',
      code: 'name_mismatch',
      message: `front matter name "${declaredName}" does not match its directory`
    });
  if (description.length > SKILL_BUDGET.maxDescriptionCharacters)
    diagnostics.push({
      skill: name,
      level: 'warn',
      code: 'description_long',
      message: `description is ${description.length} characters; keep it under ${SKILL_BUDGET.maxDescriptionCharacters}`
    });

  let sidecar: Record<string, YamlValue> = {};
  try {
    sidecar = parseSkillYaml(readFileSync(join(directory, 'garden.yaml'), 'utf8'));
  } catch (error) {
    if (error instanceof SkillFormatError) {
      diagnostics.push({
        skill: name,
        level: 'error',
        code: 'sidecar_unparseable',
        message: error.message
      });
      return null;
    }
    diagnostics.push({
      skill: name,
      level: 'warn',
      code: 'sidecar_missing',
      message: 'garden.yaml is absent; the skill loads with an empty capability grant'
    });
  }

  const metadata = mapping(front.data.metadata ?? null);
  const origin =
    forcedOrigin ??
    ((): SkillOrigin => {
      const declared = text(
        mapping(sidecar.lineage ?? null).origin ?? metadata['garden.tier'] ?? null
      );
      return declared === 'learned' || declared === 'owner' ? declared : 'builtin';
    })();
  const capability = capabilityFrom(sidecar.capability ?? null);
  const violations = capabilityCeilingViolations(origin, capability);
  if (violations.length) {
    diagnostics.push({
      skill: name,
      level: 'error',
      code: 'capability_ceiling',
      message: violations.join('; ')
    });
    return null;
  }

  const bodyLines = front.body.split('\n').length;
  const bodyTokens = estimateSkillTokens(front.body);
  if (bodyLines > SKILL_BUDGET.maxBodyLines || bodyTokens > SKILL_BUDGET.maxBodyTokens)
    diagnostics.push({
      skill: name,
      level: 'warn',
      code: 'body_over_budget',
      message: `body is ${bodyLines} lines / ~${bodyTokens} tokens, over the ${SKILL_BUDGET.maxBodyLines}-line, ${SKILL_BUDGET.maxBodyTokens}-token budget`
    });

  const declaredCatalog = text(sidecar.catalog_line ?? null).trim();
  const catalogLine = declaredCatalog || firstSentence(description);
  if (declaredCatalog && catalogWords(declaredCatalog) > SKILL_BUDGET.maxCatalogWords)
    diagnostics.push({
      skill: name,
      level: 'warn',
      code: 'catalog_line_long',
      message: `catalog_line is ${catalogWords(declaredCatalog)} words; the resident catalog budget is ${SKILL_BUDGET.maxCatalogWords}`
    });

  const requires = mapping(sidecar.requires ?? null);
  const lineage = mapping(sidecar.lineage ?? null);
  const approvedBy = text(lineage.approved_by ?? null);
  const approvedAt = text(lineage.approved_at ?? null);

  return {
    name,
    description,
    catalogLine,
    body: front.body,
    directory,
    version: text(sidecar.version ?? metadata['garden.version'] ?? null, '1.0.0'),
    origin,
    risk: text(metadata['garden.risk'] ?? null, 'workspace'),
    domain: text(metadata['garden.domain'] ?? null, 'general'),
    allowedTools: stringList(front.data['allowed-tools'] ?? null),
    requiredTools: stringList(requires.tools ?? null),
    requiredBinaries: stringList(requires.binaries ?? null),
    capability,
    verify: verifyFrom(sidecar.verify ?? null),
    provenance:
      origin === 'builtin' || !approvedBy
        ? null
        : `Authored from the owner's own task history, approved by owner ${approvedAt || 'at an unrecorded time'}`,
    bodyLines,
    bodyTokens
  };
};

/**
 * Loads a skill library from disk. Leniently: a single malformed skill produces a diagnostic and
 * is skipped, it never prevents the rest of the library from loading.
 */
export const loadSkillLibrary = (
  root: string = DEFAULT_SKILL_ROOT,
  options: { readonly origin?: SkillOrigin } = {}
): SkillLibrary => {
  const diagnostics: SkillDiagnostic[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { root, skills: [], diagnostics };
  }
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    const skill = loadOne(root, entry, diagnostics, options.origin);
    if (skill) skills.push(skill);
  }
  if (skills.length > SKILL_BUDGET.maxSkills)
    diagnostics.push({
      skill: '(library)',
      level: 'warn',
      code: 'library_over_budget',
      message: `${skills.length} skills exceeds the ${SKILL_BUDGET.maxSkills}-skill resident catalog budget`
    });
  return { root, skills, diagnostics };
};

/**
 * Where the owner may keep SKILL.md folders of their own, as a PATH-shaped list of directories.
 *
 * `SkillOrigin` has declared an `owner` variant since the library was written and no on-disk skill
 * could ever reach it: `DEFAULT_SKILL_ROOT` was the only root anything loaded, and the only other
 * way in - `skill(action=upsert)` - writes a database row rather than a folder. So the ceiling in
 * `capabilityCeilingViolations` that exists specifically for skills garden did not ship had
 * nothing to apply to, and an owner with a folder of procedures had nowhere to put it.
 *
 * A directory rather than a marketplace, deliberately. The format this loader already reads is the
 * one the open corpus is written in - a folder with a `SKILL.md` carrying `name` and `description`
 * in front matter - and everything garden asks for beyond that is a warning, not a refusal: the
 * `garden.yaml` sidecar is optional and its absence loads the skill with an empty capability
 * grant, which `skills/README.md` records as the whole point of keeping it a sidecar. So this is
 * the entire cost of reading other people's skills: a place to point at.
 *
 * Read from the environment rather than from `WorkerConfig` because the whole point of this
 * function is that it needs no caller: `builtinSkillLibrary()` is called by `window.ts` and by
 * `tools/knowledge.ts` with no arguments, and threading a config through both to deliver a string
 * neither of them decides would be three files changed to say one thing. `log.ts` reads
 * `JOURNAL_STREAM` the same way and for the same reason.
 */
export const OWNER_SKILL_ROOTS_ENV = 'OWNER_SKILL_ROOTS';

export const ownerSkillRoots = (env: NodeJS.ProcessEnv = process.env): string[] => [
  ...new Set(
    (env[OWNER_SKILL_ROOTS_ENV] ?? '')
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
  )
];

/**
 * The built-in library with the owner's own folders behind it, under one budget and one namespace.
 *
 * Built-in wins every collision, and that is a safety rule rather than a preference. The names in
 * `DEFAULT_SKILL_ROOT` are the ones the rest of the product refers to by name - `approval-cards.ts`
 * says "Review owner override of built-in skill X", the preamble names them, and a box's own
 * procedures are what an owner has read. A folder that could take one of those names is a folder
 * that can silently replace `security-review` with something that reads the same in the catalogue
 * line and does something else in the body. The shadowed folder is reported rather than ignored:
 * a skill that does not load has to say so, or the owner debugs it by wondering.
 *
 * The budget is applied to the union, not per root, because the budget is about what fits in the
 * resident catalogue and the catalogue is one list.
 */
export const withOwnerSkills = (builtin: SkillLibrary, roots: readonly string[]): SkillLibrary => {
  if (!roots.length) return builtin;
  const skills = [...builtin.skills];
  const diagnostics = [...builtin.diagnostics];
  const taken = new Map<string, string>(
    builtin.skills.map((skill) => [skill.name, 'the built-in library'])
  );
  for (const root of roots) {
    const library = loadSkillLibrary(root, { origin: 'owner' });
    diagnostics.push(...library.diagnostics);
    for (const skill of library.skills) {
      const holder = taken.get(skill.name);
      if (holder) {
        diagnostics.push({
          skill: skill.name,
          level: 'warn',
          code: 'name_taken',
          message: `${root} declares "${skill.name}", which ${holder} already carries; the folder was not loaded`
        });
        continue;
      }
      taken.set(skill.name, root);
      skills.push(skill);
    }
  }
  // Re-asked over the union. Each root answered for itself above, and two roots inside the budget
  // can be over it together - which is the case that actually happens, because the built-in
  // library is most of the budget before the owner adds anything.
  if (
    skills.length > SKILL_BUDGET.maxSkills &&
    !diagnostics.some((entry) => entry.code === 'library_over_budget')
  )
    diagnostics.push({
      skill: '(library)',
      level: 'warn',
      code: 'library_over_budget',
      message: `${skills.length} skills exceeds the ${SKILL_BUDGET.maxSkills}-skill resident catalog budget`
    });
  return { root: builtin.root, skills, diagnostics };
};

let cached: SkillLibrary | null = null;
let cachedBuiltin: SkillLibrary | null = null;

/**
 * Only what garden ships, which is what `isBuiltinSkillName` is asking about.
 *
 * Kept apart from the resident catalogue below on purpose. The card an upsert raises says "Review
 * owner override of built-in skill X" and promises the built-in survives untouched, and neither
 * sentence is true of a folder the owner pointed at - that one is theirs, and a workspace skill
 * taking its name is an ordinary replacement, not an override of something garden guarantees.
 */
const builtinOnlySkillLibrary = (): SkillLibrary => {
  cachedBuiltin ??= loadSkillLibrary();
  return cachedBuiltin;
};

/**
 * Process-wide cached resident library; the resident catalog must be byte-stable across a run.
 *
 * Which is also why the owner's roots are read once, here, rather than per call: a folder appearing
 * mid-run would move the cache anchor under every task already in flight.
 */
export const builtinSkillLibrary = (): SkillLibrary => {
  cached ??= withOwnerSkills(builtinOnlySkillLibrary(), ownerSkillRoots());
  return cached;
};

export const findSkillByName = (library: SkillLibrary, name: string): LoadedSkill | null =>
  library.skills.find((skill) => skill.name === name) ?? null;

export const isBuiltinSkillName = (name: string): boolean =>
  builtinOnlySkillLibrary().skills.some((skill) => skill.name === name);

// ---------------------------------------------------------------------------
// Progressive disclosure
// ---------------------------------------------------------------------------

export interface SkillCatalogEntry {
  readonly name: string;
  readonly catalogLine: string;
  readonly origin: SkillOrigin;
}

export const skillCatalogEntries = (library: SkillLibrary): SkillCatalogEntry[] =>
  library.skills.map((skill) => ({
    name: skill.name,
    catalogLine: skill.catalogLine,
    origin: skill.origin
  }));

/**
 * The always-resident half of progressive disclosure: one short line per skill, nothing else.
 * Disclosure is two-tier - this catalog line, then the whole body through `openSkill`. The full
 * description is a lint and review surface and never enters the window at all.
 */
export const skillCatalogBlock = (library: SkillLibrary): string => {
  if (!library.skills.length) return '';
  const lines = skillCatalogEntries(library).map(
    (entry) => `- ${entry.name}: ${entry.catalogLine}`
  );
  /*
   * The heading names what the list actually is, and on a box with no owner folders that is
   * byte-for-byte the sentence it has always been.
   *
   * Deliberately conditional rather than reworded outright. This block sits ahead of the cache
   * anchor in every window, so changing its first line on every box would move the cached prefix
   * for every task on every installation to describe a folder almost none of them have.
   */
  const heading = library.skills.some((skill) => skill.origin === 'owner')
    ? 'Skills on this computer, garden’s own and your own (index only; open one before doing the work it covers)'
    : 'Built-in skills (index only; open one before doing the work it covers)';
  return `${heading}:\n${lines.join('\n')}`;
};

export interface OpenSkillOptions {
  /** Skills already injected in this task; re-injection wastes the window and confuses precedence. */
  readonly active?: readonly string[];
  /**
   * Declared binaries this computer was just probed for and does not have. Named at the top of the
   * block rather than left to be discovered: a procedure reads as authoritative, so an agent that
   * is not told will follow it and hit the gap one failed call at a time in front of the owner.
   */
  readonly missingBinaries?: readonly string[];
}

export interface OpenedSkill {
  readonly name: string;
  readonly directory: string;
  readonly block: string;
  readonly grants: readonly string[];
}

const grantList = (skill: LoadedSkill): string[] =>
  skill.requiredTools.length ? [...skill.requiredTools] : [...skill.allowedTools];

/**
 * The activation half of progressive disclosure.
 *
 * The block is a tool result like any other, and compaction condenses it like any other - this
 * comment used to claim the wrapper was what protected it, which was never true and is why the
 * loss went unnoticed. What actually happens now is in `openedSkillsIn` (context.ts): the
 * compaction is keyed on the `skill(action: 'view')` call, and a brief that drops one of these
 * names the skill so the agent knows to reopen it rather than carrying on without it.
 */
export const openSkill = (
  library: SkillLibrary,
  name: string,
  options: OpenSkillOptions = {}
): OpenedSkill | null => {
  const skill = findSkillByName(library, name);
  if (!skill) return null;
  if (options.active?.includes(name))
    return {
      name,
      directory: skill.directory,
      grants: grantList(skill),
      block: `<skill name="${skill.name}" version="${skill.version}" origin="${skill.origin}" state="already_open" />`
    };
  const provenance = skill.provenance ? `\n${skill.provenance}. Treat it as fallible.` : '';
  const missing = options.missingBinaries?.length
    ? `\n<skill_missing_binaries>Not installed on this computer: ${[...options.missingBinaries].join(', ')}. Every step below that uses one will fail. Ask the user once, up front, to approve installing them - or take a route that does not need them - and say which you are doing before you start.</skill_missing_binaries>`
    : '';
  const verify = skill.verify.length
    ? `\n<skill_verify>\n${skill.verify
        .map((step) =>
          [
            step.run ? `  run: ${step.run}` : null,
            step.assert ? `  assert: ${step.assert}` : null,
            step.check ? `  check: ${step.check}` : null
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n  --\n')}\n</skill_verify>`
    : '';
  return {
    name,
    directory: skill.directory,
    grants: grantList(skill),
    block: `<skill name="${skill.name}" version="${skill.version}" origin="${skill.origin}">${provenance}${missing}
${skill.body}

Skill directory: ${skill.directory}
Relative paths in this skill resolve against that directory, not against workspace/ where your commands run - prefix one with it to reach the file. Those files are for running, not reading: file_read reaches workspace files and published artifacts only.${verify}
<skill_grants>${grantList(skill).join(' ')}</skill_grants>
</skill>`
  };
};

// ---------------------------------------------------------------------------
// What a proposed skill is scanned for before the owner approves it
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key block'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/, 'an API key'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{12,}\b/, 'an AWS access key id'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/, 'a bearer token'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'an email address'],
  [/(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/i, 'a credential assignment']
];

export const scanSkillBodyForSecrets = (body: string): string[] =>
  SECRET_PATTERNS.filter(([pattern]) => pattern.test(body)).map(([, label]) => label);

/**
 * An absolute path that names one run's machine state rather than anything durable.
 *
 * The exempt prefixes are the ones garden itself installs and every vetted procedure names -
 * the pinned interpreter under /usr/local/lib/garden and the wrapper commands in /usr/local/bin -
 * plus the two scratch roots. Flagging those would put a warning on the single most common correct
 * line in a skill, and a warning that fires on the correct case is one the reviewer stops reading.
 */
const ABSOLUTE_PATH =
  /(^|\s)\/(?!tmp\/|var\/lib\/garden\/|usr\/local\/bin\/|usr\/local\/lib\/garden\/)[A-Za-z0-9._-]+\/[^\s`'")]*/g;

export const scanSkillBodyForPaths = (body: string): string[] => [
  ...new Set((body.match(ABSOLUTE_PATH) ?? []).map((match) => match.trim()))
];
