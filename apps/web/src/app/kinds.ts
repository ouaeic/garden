import { Box, Code, Doc, Film, File, Globe, Image, Slides, Table } from './icons';

/**
 * What a file is, in the owner's words: the shelf it sits on in the Library and the mark it carries
 * wherever it is listed. Decided by extension first, because a box writes many files as
 * `application/octet-stream`, and by the declared type when the name says nothing.
 */
export type KindId =
  | 'doc'
  | 'slides'
  | 'site'
  | 'data'
  | 'image'
  | 'media'
  | 'code'
  | 'archive'
  | 'other';

export const KINDS: Record<KindId, { label: string; plural: string; icon: typeof Doc }> = {
  doc: { label: 'Document', plural: 'Documents', icon: Doc },
  slides: { label: 'Slides', plural: 'Slides', icon: Slides },
  site: { label: 'Page', plural: 'Pages and sites', icon: Globe },
  data: { label: 'Data', plural: 'Data', icon: Table },
  image: { label: 'Image', plural: 'Images', icon: Image },
  media: { label: 'Audio or video', plural: 'Audio and video', icon: Film },
  code: { label: 'Code', plural: 'Code', icon: Code },
  archive: { label: 'Archive', plural: 'Archives', icon: Box },
  other: { label: 'File', plural: 'Other files', icon: File }
};

const BY_EXTENSION: [RegExp, KindId][] = [
  [/\.(pptx?|key|odp)$/i, 'slides'],
  [/\.(md|markdown|txt|rtf|docx?|odt|pdf|tex|epub)$/i, 'doc'],
  [/\.(html?|svelte|vue)$/i, 'site'],
  [/\.(csv|tsv|xlsx?|ods|json|jsonl|parquet|sqlite|db|ipynb|xml|ya?ml)$/i, 'data'],
  [/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico)$/i, 'image'],
  [/\.(mp3|wav|m4a|ogg|flac|aac|mp4|mov|webm|mkv|avi)$/i, 'media'],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i, 'archive'],
  [
    /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|css|scss|lua|r|jl|dart|toml|ini|lock)$/i,
    'code'
  ]
];

const BY_TYPE: [RegExp, KindId][] = [
  [/^image\//, 'image'],
  [/^(audio|video)\//, 'media'],
  [/^(text\/html|application\/xhtml)/, 'site'],
  [/(csv|tab-separated|json|xml|yaml|spreadsheet|excel|sqlite|parquet|ipynb)/, 'data'],
  [/(presentation|powerpoint|keynote)/, 'slides'],
  [/(zip|tar|gzip|compressed|7z|rar)/, 'archive'],
  [
    /^(application\/(pdf|msword|rtf|epub)|text\/|application\/vnd\.openxmlformats-officedocument\.wordprocessing)/,
    'doc'
  ],
  [/(javascript|typescript|x-python|x-sh|x-c)/, 'code']
];

export function kindOf(name: string, mimeType = ''): (typeof KINDS)[KindId] & { id: KindId } {
  const type = mimeType.split(';')[0]!.trim().toLowerCase();
  const id =
    BY_EXTENSION.find(([pattern]) => pattern.test(name))?.[1] ??
    BY_TYPE.find(([pattern]) => pattern.test(type))?.[1] ??
    'other';
  return { id, ...KINDS[id] };
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
