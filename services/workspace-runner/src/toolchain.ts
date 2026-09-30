import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentSearchPath, hostSearchPath, packageInstallCommandLine } from './execution.js';
import { resolveExecutable } from './command-policy.js';

/**
 * What a document job needs, grouped by the job rather than by the package, because "you cannot
 * make a slide deck" is the sentence the agent has to be able to say — not "python3-pptx is
 * absent". Every entry names the command that would provide it, so one approval covers the gap
 * instead of the agent discovering it one failed call at a time in front of the owner.
 */
export interface ToolchainCapability {
  id: string;
  purpose: string;
  binaries: readonly string[];
  pythonModules: readonly string[];
  fonts: readonly string[];
  /**
   * Capability keys in the host package table (`scripts/garden-host.sh`), resolved to the names
   * this host's own distribution uses at report time.
   *
   * They were command lines - `apt-get install -y imagemagick graphviz python3-pil` - which is one
   * of the four families this computer installs on. On the other three the one sentence telling an
   * agent how to close a gap named a binary the host has never had, and named packages under
   * spellings its repositories do not carry. The table is where those names already live, for the
   * installer and for `garden doctor`; naming a capability rather than a package is what lets
   * this report read the same list they do.
   */
  packages?: readonly string[];
  /** The half of a repair no package name expresses, said after the command line. */
  beyondPackages?: string;
  /**
   * What a host whose package table cannot be read is told, which is every host that is not this
   * product installed on a distribution - a developer's laptop, a container without an
   * /etc/os-release. Host-neutral on purpose: a sentence that guesses apt here would be the same
   * defect one layer down.
   */
  install: string;
}

/** What this host's distribution calls the things the toolchain needs. */
export interface HostPackages {
  /** The package manager this host actually has, probed the way the installer probes it. */
  manager: string;
  /** Capability key to the package name this family uses. */
  packages: Map<string, string>;
  /** Capability keys this family has no package for, so the report can say so rather than lie. */
  unavailable: Set<string>;
}

/**
 * The one Python the document skills name. It is a virtual environment created with
 * --system-site-packages, so it sees both the distribution's python-docx, openpyxl, pandas,
 * matplotlib and Pillow and the versions garden pins itself. Probing through it rather
 * than through `python3` is what makes "is pypdf importable" the same question the agent will ask.
 */
export const GARDEN_PYTHON = '/usr/local/lib/garden/python/bin/python3';

export const DOCUMENT_TOOLCHAIN: readonly ToolchainCapability[] = [
  {
    id: 'office-authoring',
    purpose: 'Write .docx, .pptx and .xlsx as real Office files rather than hand-rolled XML',
    binaries: [GARDEN_PYTHON],
    pythonModules: ['pptx', 'docx', 'openpyxl'],
    fonts: [],
    packages: ['python-docx', 'python-openpyxl'],
    // python-pptx is not the distribution's any more: Ubuntu packaged it up to 24.04 and stopped,
    // so it is pinned in infra/native/garden-python-requirements.txt and installed into the one
    // interpreter above. Naming the reinstall rather than a package line that would not work.
    beyondPackages:
      're-run the garden installer to restore the pinned Python environment, which is where python-pptx comes from',
    install:
      "install this host's python-docx and python-openpyxl packages, then re-run the garden installer to restore the pinned Python environment"
  },
  {
    id: 'office-conversion',
    purpose:
      'Turn an Office file into a PDF, or recalculate a workbook, through one command that fails when the bytes are not there instead of exiting 0',
    binaries: [
      'garden-office-convert',
      'soffice',
      'pdftoppm',
      'pdffonts',
      'pdfinfo',
      'pdftotext',
      'pdfimages'
    ],
    pythonModules: [],
    fonts: [],
    packages: ['office-writer', 'office-impress', 'office-calc', 'poppler'],
    install:
      "install this host's LibreOffice writer, impress and calc packages and its poppler utilities"
  },
  {
    id: 'document-fonts',
    purpose:
      'Lay out Calibri and Cambria documents at the metrics they were written for, and give a typeset document and a rendered slide a face that is actually installed',
    binaries: ['fc-list'],
    pythonModules: [],
    fonts: ['Carlito', 'Caladea', 'Liberation Sans', 'Liberation Serif', 'DejaVu Sans'],
    packages: [
      'fontconfig',
      'font-carlito',
      'font-caladea',
      'font-liberation',
      'font-dejavu',
      'font-noto'
    ],
    install:
      "install this host's fontconfig and its Carlito, Caladea, Liberation, DejaVu and Noto font packages"
  },
  {
    id: 'pdf-assembly',
    purpose:
      'Split, merge, rotate, stamp, encrypt, redact and structurally check a PDF. img2pdf rebuilds a rasterised page, which is what makes a redaction remove the characters rather than cover them',
    binaries: ['qpdf', 'img2pdf'],
    pythonModules: [],
    fonts: [],
    packages: ['qpdf', 'img2pdf'],
    install: "install this host's qpdf and img2pdf packages"
  },
  {
    id: 'pdf-forms',
    purpose: 'Enumerate and fill the fields of a PDF form, which is the one PDF job qpdf cannot do',
    binaries: [GARDEN_PYTHON],
    pythonModules: ['pypdf'],
    fonts: [],
    install:
      'reinstall the pinned document Python environment, which scripts/install-native.sh creates from infra/native/garden-python-requirements.txt'
  },
  {
    id: 'pdf-extraction',
    purpose:
      'Read text, tables and page geometry out of a PDF, read a scanned one off pictures of its pages, and give it a text layer of its own so it stays readable',
    // pdftoppm belongs to this capability as well as to conversion: it is what renders a page of a
    // scan for the recogniser, so document_read and document_search read a scan when this whole
    // list is present and say they cannot when any of it is missing. A capability that reported
    // itself ready without it would be claiming a reading the computer could not perform.
    binaries: [
      'pdftotext',
      'pdfinfo',
      'pdftoppm',
      'garden-pdf-tables',
      'ocrmypdf',
      'tesseract',
      'gs'
    ],
    pythonModules: [],
    fonts: [],
    // ghostscript arrives as a dependency of ocrmypdf, and is what compresses an oversized PDF.
    packages: ['poppler', 'ocrmypdf', 'tesseract', 'tesseract-english'],
    install:
      "install this host's poppler utilities, ocrmypdf, and tesseract with its English language data"
  },
  {
    id: 'typeset-pdf',
    purpose:
      'Typeset a CV, a one-pager or a report straight to a PDF, with exact control over where the page breaks - which is what decides whether a CV is one page or two',
    binaries: ['typst'],
    pythonModules: [],
    fonts: [],
    install: 'install the pinned typst release, which scripts/install-native.sh does'
  },
  {
    id: 'data-analysis',
    purpose: 'Read, reshape and chart spreadsheet and CSV data',
    binaries: [GARDEN_PYTHON],
    // numpy is not a fourth package: pandas and matplotlib both depend on it, so it is on every box
    // that has either. It is named because procedures import it directly, and a capability list
    // that leaves out what the work actually calls is the list that sends an agent guessing.
    pythonModules: ['pandas', 'numpy', 'matplotlib'],
    fonts: [],
    packages: ['python-pandas', 'python-matplotlib'],
    install: "install this host's pandas and matplotlib packages, which bring numpy with them"
  },
  {
    id: 'parquet-data',
    purpose: 'Read and write typed Parquet tables with pandas',
    binaries: [GARDEN_PYTHON],
    pythonModules: ['pandas', 'pyarrow'],
    fonts: [],
    packages: ['python-pandas'],
    install: 'run sudo garden update to restore the pinned Parquet reader and pandas'
  },
  {
    /**
     * Separate from data-analysis on purpose. Charting a column and testing whether a difference is
     * real are different jobs, and folding them together would mean a box without the statistics
     * packages reported that it could not chart either.
     *
     * The gap this closes: with pandas and matplotlib alone, a confidence interval, a significance
     * test or a seasonal forecast is arithmetic done by a language model in its own head. That is
     * the class of answer that is wrong in a way nobody notices - a plausible p-value, a sound-
     * looking interval - and it is handed to the owner as a finding about their own data.
     *
     * Two packages and no more. scipy carries the distributions and the tests; statsmodels carries
     * the models that state their own uncertainty - regression with standard errors, seasonal
     * decomposition, exponential smoothing. Both come from the distribution, signed and security
     * supported, and statsmodels pulls scipy in anyway, so the pair costs one download. Nothing
     * here needs a machine-learning stack: scikit-learn would add a few hundred megabytes to
     * answer questions nobody asks of a household spreadsheet, and a deep-learning runtime would
     * be gigabytes on a computer whose contract says no model weights run locally.
     */
    id: 'statistics',
    purpose:
      'Answer a question about data with a stated confidence rather than arithmetic done in a model’s head - a confidence interval, a significance test, a regression, a seasonal decomposition or a forecast',
    binaries: [GARDEN_PYTHON],
    pythonModules: ['scipy', 'statsmodels'],
    fonts: [],
    packages: ['python-scipy', 'python-statsmodels'],
    install: "install this host's scipy and statsmodels packages"
  },
  {
    id: 'image-work',
    purpose: 'Crop, resize, composite and convert images, and render diagrams',
    binaries: [GARDEN_PYTHON, 'magick', 'dot'],
    pythonModules: ['PIL'],
    fonts: [],
    packages: ['imagemagick', 'graphviz', 'python-pillow'],
    install: "install this host's ImageMagick, graphviz and Pillow packages"
  },
  {
    id: 'media',
    // Reading a recording depends on this one and on nothing else installed here: audio_read cuts
    // and re-encodes the window locally before anything leaves the computer, so a box without
    // ffmpeg cannot listen to a voice memo at all, however the transcription itself is reached.
    purpose: 'Inspect and transcode audio and video, and prepare a recording to be read',
    binaries: ['ffmpeg', 'ffprobe'],
    pythonModules: [],
    fonts: [],
    packages: ['ffmpeg'],
    install: "install this host's ffmpeg package"
  }
];

export interface ToolchainCapabilityReport {
  id: string;
  purpose: string;
  ready: boolean;
  missingBinaries: string[];
  missingPythonModules: string[];
  missingFonts: string[];
  /** Only present when something is missing; a ready capability has nothing to install. */
  install?: string;
}

export interface ToolchainReport {
  capabilities: ToolchainCapabilityReport[];
  ready: string[];
  missing: string[];
  summary: string;
}

/**
 * The sentence a missing capability is closed with, on this host.
 *
 * Three shapes, and each of them is a fact rather than a guess. With the host table readable it is
 * a command line this computer's own package manager accepts and this computer's own policy will
 * carry out. Without it - a laptop, a container with no release file - it is the capability's
 * host-neutral sentence, which says what to install without naming a manager that may not be
 * there. And a capability whose family genuinely packages nothing for part of it says so, because
 * "install ocrmypdf" on a host with no ocrmypdf is an instruction that cannot be followed and an
 * agent will spend a turn discovering that.
 */
export const installAdvice = (capability: ToolchainCapability, host?: HostPackages): string => {
  const keys = capability.packages ?? [];
  if (!host || !keys.length) return capability.install;
  const names = keys.map((key) => host.packages.get(key)).filter((name): name is string => !!name);
  const unavailable = keys.filter((key) => host.unavailable.has(key));
  const parts = [
    packageInstallCommandLine(host.manager, names),
    unavailable.length
      ? `this host's distribution packages nothing for ${unavailable.join(', ')}`
      : undefined,
    capability.beyondPackages
  ].filter((part): part is string => !!part);
  // Everything the table could have said about this capability came back empty, which is not the
  // same as the table saying there is nothing to install. Falling back keeps the report from
  // answering a real gap with an empty sentence.
  return parts.length ? parts.join('; ') : capability.install;
};

/** Present binaries and modules are the inputs; what is missing per capability is the answer. */
export const reportToolchain = (
  capabilities: readonly ToolchainCapability[],
  available: { binaries: Set<string>; pythonModules: Set<string>; fonts: Set<string> },
  host?: HostPackages
): ToolchainCapabilityReport[] =>
  capabilities.map((capability) => {
    const missingBinaries = capability.binaries.filter((name) => !available.binaries.has(name));
    const missingPythonModules = capability.pythonModules.filter(
      (name) => !available.pythonModules.has(name)
    );
    const missingFonts = capability.fonts.filter(
      (name) => !available.fonts.has(name.toLowerCase())
    );
    const ready =
      missingBinaries.length === 0 &&
      missingPythonModules.length === 0 &&
      missingFonts.length === 0;
    return {
      id: capability.id,
      purpose: capability.purpose,
      ready,
      missingBinaries,
      missingPythonModules,
      missingFonts,
      ...(ready ? {} : { install: installAdvice(capability, host) })
    };
  });

/**
 * One line the agent can be shown before it commits to a plan. It deliberately leads with what
 * works: an agent told only what is broken picks a worse route than one told which route is open.
 */
export const summariseToolchain = (reports: readonly ToolchainCapabilityReport[]): string => {
  const ready = reports.filter((report) => report.ready);
  const missing = reports.filter((report) => !report.ready);
  const parts: string[] = [];
  parts.push(
    ready.length
      ? `Available on this computer: ${ready.map((report) => report.id).join(', ')}.`
      : 'No document toolchain is installed on this computer.'
  );
  if (missing.length)
    parts.push(
      `Not installed: ${missing
        .map((report) => `${report.id} (needs ${report.install})`)
        .join(
          '; '
        )}. Ask before installing, and do not follow a procedure that depends on one of these until it is there.`
    );
  return parts.join(' ');
};

/** Font family names fontconfig reports, lowercased, from `fc-list --format=%{family}\n`. */
export const parseFontFamilies = (output: string): Set<string> => {
  const families = new Set<string>();
  for (const line of output.split('\n'))
    for (const family of line.split(','))
      if (family.trim()) families.add(family.trim().toLowerCase());
  return families;
};

/** Modules the probe reported as importable, one per line, ignoring anything else python said. */
export const parseImportableModules = (output: string, requested: readonly string[]): Set<string> =>
  new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => requested.includes(line))
  );

const PROBE_TIMEOUT_MS = 8_000;

const runProbe = async (executable: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : null);
    });
  });

/**
 * Resolved the same way an agent command would resolve it: same PATH, same symlink following.
 * Anything else would report a binary the agent then cannot run, which is the failure this
 * whole module exists to remove.
 */
export const probeBinaries = async (
  root: string,
  names: readonly string[]
): Promise<Set<string>> => {
  const searchPath = agentSearchPath(root);
  const found = new Set<string>();
  await Promise.all(
    [...new Set(names)].map(async (name) => {
      if (await resolveExecutable(name, searchPath, root)) found.add(name);
    })
  );
  return found;
};

const IMPORT_PROBE = `import importlib.util, sys
for name in sys.argv[1:]:
    try:
        if importlib.util.find_spec(name) is not None:
            print(name)
    except Exception:
        pass
`;

/**
 * Asked of the pinned interpreter and no other. A module that only the distribution's `python3`
 * can import is a module no vetted procedure may use, so reporting it as present would put the
 * agent back to guessing which python to run.
 */
export const probePythonModules = async (
  root: string,
  modules: readonly string[]
): Promise<Set<string>> => {
  const wanted = [...new Set(modules)];
  if (!wanted.length) return new Set();
  const python = await resolveExecutable(GARDEN_PYTHON, agentSearchPath(root), root);
  if (!python) return new Set();
  const output = await runProbe(python, ['-c', IMPORT_PROBE, ...wanted]);
  return output === null ? new Set() : parseImportableModules(output, wanted);
};

/**
 * The one file that knows what a capability is called on this distribution, and the same one the
 * installer sources and `garden-system-packages` dispatches through. Reached by a path relative
 * to this module, which lands on the checkout root from `src/` and from `dist/` alike.
 */
const HOST_DEFINITIONS = fileURLToPath(new URL('../../../scripts/garden-host.sh', import.meta.url));

/**
 * Asked of the host table itself rather than reimplemented here.
 *
 * The whole point of that table is that the package names live in one place; parsing it in
 * TypeScript would make this the fifth reader with its own idea of what a family is and how a
 * derivative maps onto one. So the shell answers, using its own detection, and this reads the
 * two-column result.
 */
const HOST_PACKAGE_PROBE = `. "$1" >/dev/null 2>&1 || exit 1
shift
garden_detect_host >/dev/null 2>&1 || exit 1
printf 'manager\t%s\n' "$garden_pm"
for capability in "$@"; do
  printf '%s\t%s\n' "$capability" "$(garden_package_for "$capability" "$garden_family")"
done
`;

/**
 * What this host calls the packages behind a list of capabilities, or nothing at all.
 *
 * Nothing at all is an ordinary answer, not a failure: a developer's laptop and a container
 * without /etc/os-release both reach it, and both are told the host-neutral sentence instead. What
 * would be a failure is guessing - which is what naming apt unconditionally was.
 */
export const hostPackages = async (
  capabilities: readonly string[],
  // Overridable so that the table can be read as a host this one is not. Every family's column has
  // to be answerable somewhere, and a probe that can only ever be asked about the machine running
  // it is a probe that is only ever tested on one of the four.
  definitions: string = HOST_DEFINITIONS
): Promise<HostPackages | undefined> => {
  const wanted = [...new Set(capabilities)];
  if (!wanted.length) return undefined;
  const output = await runProbe('/bin/sh', [
    '-c',
    HOST_PACKAGE_PROBE,
    'garden-host',
    definitions,
    ...wanted
  ]);
  if (output === null) return undefined;
  let manager = '';
  const packages = new Map<string, string>();
  const unavailable = new Set<string>();
  for (const line of output.split('\n')) {
    const [key, value = ''] = line.split('\t');
    if (!key) continue;
    if (key === 'manager') manager = value.trim();
    else if (value.trim()) packages.set(key, value.trim());
    else if (wanted.includes(key)) unavailable.add(key);
  }
  return manager ? { manager, packages, unavailable } : undefined;
};

/**
 * The families fontconfig knows, asked of the host's own fc-list and no other.
 *
 * The one probe here that does not resolve the way an agent command would, and the difference is
 * that this one runs what it finds: `probeBinaries` above stops at resolution, this spawns. On
 * `agentSearchPath` a file the agent had written called `fc-list` would be executed by the runner,
 * outside the sandbox, and would also get to decide which fonts this report claims. @see
 * hostSearchPath.
 *
 * The cost is one honest disagreement: a box whose only fc-list sits under `$HOME` reports the
 * binary present, through `probeBinaries`, and its font families missing. Reporting a family on
 * the word of a binary the agent supplied is the worse of the two answers.
 */
export const probeFonts = async (root: string, fonts: readonly string[]): Promise<Set<string>> => {
  if (!fonts.length) return new Set();
  const listing = await resolveExecutable('fc-list', hostSearchPath, root);
  if (!listing) return new Set();
  const output = await runProbe(listing, ['--format=%{family}\\n']);
  return output === null ? new Set() : parseFontFamilies(output);
};

/**
 * The whole picture, probed fresh. It is deliberately not cached: the agent's first move after
 * reading it may be to install what is missing, and a cached answer would then tell it the
 * package it just installed is still absent.
 */
export const toolchainReport = async (root: string): Promise<ToolchainReport> => {
  const [binaries, pythonModules, fonts, host] = await Promise.all([
    probeBinaries(
      root,
      DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.binaries)
    ),
    probePythonModules(
      root,
      DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.pythonModules)
    ),
    probeFonts(
      root,
      DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.fonts)
    ),
    hostPackages(DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.packages ?? []))
  ]);
  const capabilities = reportToolchain(
    DOCUMENT_TOOLCHAIN,
    { binaries, pythonModules, fonts },
    host
  );
  return {
    capabilities,
    ready: capabilities.filter((report) => report.ready).map((report) => report.id),
    missing: capabilities.filter((report) => !report.ready).map((report) => report.id),
    summary: summariseToolchain(capabilities)
  };
};
