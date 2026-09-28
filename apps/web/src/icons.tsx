import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

const icon = (path: string) =>
  function PixelIcon({ size = 24, className = '', ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        className={`pixel-icon ${className}`}
        {...props}
      >
        <path d={path} />
      </svg>
    );
  };

/*! Pixelarticons (c) Gerrit Halfmann, MIT. License: /licenses/pixelarticons.txt */
export const Activity = /* @__PURE__ */ icon(
  'M22 22H4v-2h18v2ZM4 20H2V2h2v18Zm4-6H6v-2h2v2Zm8 0h-2v-2h2v2Zm-6-2H8v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2h-2V8h2v2Zm8 0h-2V8h2v2Zm2-2h-2V6h2v2Z'
);
export const ArrowLeft = /* @__PURE__ */ icon(
  'M20 11v2H4v-2zM8 13v2H6v-2zm2 2v2H8v-2zm2 2v2h-2v-2zm-4-6V9H6v2z M10 15V7H8v8zm2 2V5h-2v12z'
);
export const ArrowRight = /* @__PURE__ */ icon(
  'M4 11v2h16v-2zm12 2v2h2v-2zm-2 2v2h2v-2zm-2 2v2h2v-2zm4-6V9h2v2z M14 15V7h2v8zm-2 2V5h2v12z'
);
export const ArrowUpRight = /* @__PURE__ */ icon(
  'M8 4h12v12h-2V8h-2V6H8zM16 8h2v2h-2zM14 10h2v2h-2zM12 12h2v2h-2zM10 14h2v2h-2zM8 16h2v2H8zM6 18h2v2H6z'
);
export const AudioLines = /* @__PURE__ */ icon(
  'M3 7h2v5H3zm4 0h2v13H7zm4-3h2v16h-2zm4 0h2v13h-2zM5 5h2v2H5zm4 15h2v2H9zm4-18h2v2h-2zm4 15h2v2h-2zm2-5h2v5h-2zm2-2h2v2h-2zM1 12h2v2H1z'
);
export const Bell = /* @__PURE__ */ icon(
  'M9 2h6v2H9zM7 4h2v2H7zm8 0h2v2h-2zM5 6h2v7H5zm12 0h2v7h-2zM3 13h2v4H3zm16 0h2v4h-2z M3 15h18v2H3zm5 3h2v2H8zm6 0h2v2h-2zm-4 2h4v2h-4z'
);
export const Check = /* @__PURE__ */ icon(
  'M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z'
);
export const CheckCircle2 = /* @__PURE__ */ icon(
  'M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM7 12h2v2H7zm2 2h2v2H9zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z'
);
export const ChevronDown = /* @__PURE__ */ icon(
  'M13 16h-2v-2h2v2Zm-2-2H9v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2H7v-2h2v2Zm8 0h-2v-2h2v2ZM7 10H5V8h2v2Zm12 0h-2V8h2v2Z'
);
export const ChevronRight = /* @__PURE__ */ icon(
  'M16 13v-2h-2v2h2Zm-2-2V9h-2v2h2Zm0 4v-2h-2v2h2Zm-2-6V7h-2v2h2Zm0 8v-2h-2v2h2ZM10 7V5H8v2h2Zm0 12v-2H8v2h2Z'
);
export const CircleAlert = /* @__PURE__ */ icon(
  'M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z'
);
export const CircleDollarSign = /* @__PURE__ */ icon(
  'M17 18h-4v4h-2v-4H7v-2h10v2Zm2-2h-2v-3h2v3Zm-2-3H7v-2h10v2ZM7 11H5V8h2v3Zm6-5h4v2H7V6h4V2h2v4Z'
);
export const Clock3 = /* @__PURE__ */ icon(
  'M6 2h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zM4 4h2v2H4zm2 18h12v-2H6zm12-2h2v-2h-2zM4 20h2v-2H4zm7-14h2v7h-2zm2 7h2v2h-2zm2 2h2v2h-2z'
);
export const CloudUpload = /* @__PURE__ */ icon(
  'M19 21H5v-2h14v2ZM5 19H3v-4h2v4Zm16 0h-2v-4h2v4ZM13 5h2v2h2v2h-4v8h-2V9H7V7h2V5h2V3h2v2Z'
);
export const Command = /* @__PURE__ */ icon(
  'M21 21H3v-2h18v2ZM3 19H1V5h2v14Zm20 0h-2V5h2v14Zm-5-2H6v-2h12v2Zm-9-4H7v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2ZM7 9H5V7h2v2Zm4 0H9V7h2v2Zm4 0h-2V7h2v2Zm4 0h-2V7h2v2Zm2-4H3V3h18v2Z'
);
export const Copy = /* @__PURE__ */ icon(
  'M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4z'
);
export const Download = /* @__PURE__ */ icon(
  'M21 15v4h-2v-4zm-2 4v2H5v-2zM5 15v4H3v-4zm8-12v14h-2V3z M7 11v2h10v-2zm2 2v2h2v-2zm4 0v2h2v-2z M15 11v2h2v-2z'
);
export const ExternalLink = /* @__PURE__ */ icon(
  'M11 5H5v2h6V5ZM5 7H3v12h2V7Zm12 12H5v2h12v-2Zm2-6h-2v6h2v-6Zm-8 0H9v2h2v-2Zm2-2h-2v2h2v-2Zm2-2h-2v2h2V9Zm2-2h-2v2h2V7Zm2-2h-2v2h2V5Zm2-2h-2v8h2V3Z M21 3h-8v2h8V3Z'
);
export const File = /* @__PURE__ */ icon(
  'M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z M12 8h6v2h-6z'
);
export const FileText = /* @__PURE__ */ icon(
  'M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z M12 8h6v2h-6zm-4 8h8v2H8zm0-4h8v2H8zm0-4h2v2H8z'
);
export const Film = /* @__PURE__ */ icon(
  'M20 17V7h2v10zm-2-2V9h2v6zM2 7h2v10H2zm14 0h2v10h-2zM4 5h12v2H4zm0 12h12v2H4z'
);
export const Folder = /* @__PURE__ */ icon(
  'M4 4h6v2H4zm0 14h16v2H4zM20 8h2v10h-2zM2 6h2v12H2zm8 0h10v2H10z'
);
export const FolderOpen = /* @__PURE__ */ icon(
  'M4 4h6v2H4zm0 14h16v2H4zM20 8h2v10h-2zM2 6h2v12H2zm8 0h10v2H10z'
);
export const Gauge = /* @__PURE__ */ icon(
  'M5 19H3v-2h2v2Zm16 0h-2v-2h2v2ZM3 17H1v-6h2v6Zm11 0h-4v-4h1V5h2v8h1v4Zm9 0h-2v-6h2v6ZM5 11H3V9h2v2Zm16 0h-2V9h2v2ZM9 9H5V7h4v2Zm10 0h-4V7h4v2Z'
);
export const GitBranch = /* @__PURE__ */ icon(
  'M4 14h4v2H4zm0 6h4v2H4zm-2-4h2v4H2zm6 0h2v4H8zm8-14h4v2h-4zm0 6h4v2h-4zm-2-4h2v4h-2zm6 0h2v4h-2zm-8 13h5v2h-5zm5-5h2v5h-2zM5 2h2v10H5z'
);
export const GitMerge = /* @__PURE__ */ icon(
  'M4 2h4v2H4zm0 6h4v2H4zM2 4h2v4H2zm6 0h2v4H8zm8 10h4v2h-4zm0 6h4v2h-4zm-2-4h2v4h-2zm6 0h2v4h-2zM5 12h2v10H5zm7 0h2v2h-2zm-2-2h2v2h-2z'
);
export const Globe = /* @__PURE__ */ icon(
  'M6 2h12v2H6zm0 18h12v2H6zM4 4h2v2H4zm5 0h2v2H9zm0 14h2v2H9zm4 0h2v2h-2zM7 6h2v12H7zm8 0h2v12h-2zm-2-2h2v2h-2zm7 0h-2v2h2zM2 6h2v12H2zm20 0h-2v12h2zM4 18h2v2H4zm16 0h-2v2h2z M3 11h18v2H3z'
);
export const HardDrive = /* @__PURE__ */ icon(
  'M6 7h4v2H6zm0 8h4v2H6zM2 5h2v14H2zm18 0h2v14h-2zM4 19h16v2H4zM4 3h16v2H4zm0 8h16v2H4z'
);
export const History = /* @__PURE__ */ icon(
  'M6 2h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zM4 4h2v2H4zm2 18h12v-2H6zm12-2h2v-2h-2zM4 20h2v-2H4zm7-14h2v7h-2zm2 7h2v2h-2zm2 2h2v2h-2z'
);
export const Layers = /* @__PURE__ */ icon(
  'M5 21H3v-2h2v2Zm4 0H7v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2ZM5 17H3v-2h2v2Zm16 0h-2v-2h2v2ZM5 13H3v-2h2v2Zm16 0h-2v-2h2v2ZM5 9H3V7h2v2Zm16 0h-2V7h2v2ZM5 5H3V3h2v2Zm4 0H7V3h2v2Zm4 0h-2V3h2v2Zm4 0h-2V3h2v2Zm4 0h-2V3h2v2Z'
);
export const LibraryBig = /* @__PURE__ */ icon(
  'M2 3h9v2H2zM0 19h11v2H0zM13 3h9v2h-9zm0 16h11v2H13zM11 5h2v18h-2zM0 5h2v14H0zm22 0h2v14h-2zm-7 2h5v2h-5zm0 4h5v2h-5zm0 4h2v2h-2z'
);
export const Leaf = /* @__PURE__ */ icon(
  'M1 18h2v4H1zm2-2h2v2H3zm2-2h6v2H5zm6-2h2v2h-2zm-6 6h4v2H5zm4 2h4v2H9zm4-2h4v2h-4zm4-2h2v2h-2zm2-8h2v8h-2zm0-4h2v4h-2zm-2-2h2v2h-2zm-4 2h4v2h-4zM7 6h6v2H7zM5 8h2v2H5zm-2 2h2v4H3z'
);
export const LoaderCircle = /* @__PURE__ */ icon(
  'M13 22h-2v-6h2v6Zm-6-3H5v-2h2v2Zm12 0h-2v-2h2v2ZM9 17H7v-2h2v2Zm8 0h-2v-2h2v2Zm-9-4H2v-2h6v2Zm14 0h-6v-2h6v2ZM9 9H7V7h2v2Zm8 0h-2V7h2v2Zm-4-1h-2V2h2v6ZM7 7H5V5h2v2Zm12 0h-2V5h2v2Z'
);
export const Maximize2 = /* @__PURE__ */ icon(
  'M4 13h16v-2H4zm7-8h2V3h-2zM9 7h4V5H9zm4 0h2V5h-2zm2 2h2V7h-2zM7 9h8V7H7zm4 10h2v2h-2zm-2-2h4v2H9zm4 0h2v2h-2zm2-2h2v2h-2zm-8 0h8v2H7z'
);
export const MemoryStick = /* @__PURE__ */ icon(
  'M3 4h18v2H3zM1 6h2v3H1zm0 5h2v7H1zm20 0h2v7h-2zM3 9h2v2H3zm16 0h2v2h-2zm2-3h2v3h-2zM3 18h18v2H3zm0-4h18v2H3zm2 2h2v2H5zm4 0h2v2H9zm4 0h2v2h-2zm4 0h2v2h-2zM7 8h2v4H7zm4 0h2v4h-2zm4 0h2v4h-2z'
);
export const MessageSquare = /* @__PURE__ */ icon(
  'M20 2H4v2h16zm0 14H6v2h14zm2-12h-2v12h2zM4 4H2v18h2zm2 14H4v2h2z'
);
export const MessageSquarePlus = /* @__PURE__ */ icon(
  'M4 18h2v2H4v2H2V4h2v14Zm6 0H6v-2h4v2Zm6-6h4v2h-4v4h-2v-2h-2v-2h-2v-2h2v-2h2V8h2v4Zm6 4h-2v-2h2v2Zm0-6h-2V4h2v6Zm-2-6H4V2h16v2Z'
);
export const Mic = /* @__PURE__ */ icon(
  'M10 2h4v2h-4zM8 4h2v10H8zm2 10h4v2h-4zm4-10h2v10h-2zM4 10h2v6H4zm2 6h2v2H6zm2 2h8v2H8zm8-2h2v2h-2zm2-6h2v6h-2zm-7 10h2v2h-2z'
);
export const MicOff = /* @__PURE__ */ icon(
  'M10 2h4v2h-4zM8 8h2v6H8zm2 6h4v2h-4zm4-10h2v6h-2zM4 10h2v6H4zm2 6h2v2H6zm2 2h8v2H8zm8-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2z M8 8h2v2H8zM6 6h2v2H6zM4 4h2v2H4zM2 2h2v2H2zm16 16h2v2h-2zm2 2h2v2h-2zm-2-10h2v4h-2zm-7 10h2v2h-2z'
);
export const Minimize2 = /* @__PURE__ */ icon(
  'M7 19h2v-2h2v-2h2v2h2v2h2v2H7v-2Zm13-6H4v-2h16v2Zm-3-8h-2v2h-2v2h-2V7H9V5H7V3h10v2Z'
);
export const Moon = /* @__PURE__ */ icon(
  'M18 22H8v-2h10v2ZM8 20H6v-2h2v2Zm12 0h-2v-2h2v2ZM6 18H4v-2h2v2Zm16 0h-2v-4h-2v-2h2v-2h2v8ZM4 16H2V6h2v10Zm14 0h-6v-2h6v2Zm-6-2h-2v-2h2v2Zm-2-2H8V6h2v6ZM6 6H4V4h2v2Zm8-2h-2v2h-2V4H6V2h8v2Z'
);
export const MoreHorizontal = /* @__PURE__ */ icon(
  'M3 9h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM1 11h2v2H1zm8 0h2v2H9zm8 0h2v2h-2zM3 13h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM5 11h2v2H5zm8 0h2v2h-2zm8 0h2v2h-2z'
);
export const Paperclip = /* @__PURE__ */ icon(
  'M7 7v10H5V7zm12 0v12h-2V7zm-8 2v10H9V9zm4 0v8h-2V9zm0-6v2H9V3zm-2 4v2h-2V7zm4 12v2h-6v-2zm0-14v2h-2V5zM9 5v2H7V5z'
);
export const Pause = /* @__PURE__ */ icon(
  'M10 20H4V4h6v16Zm8-16v16h-6V4h6Zm-4 2v12h2V6h-2ZM6 18h2V6H6v12Z'
);
export const Pin = /* @__PURE__ */ icon(
  'M7 2h10v2H7zM5 4h2v2H5zm14 0h-2v2h2zM7 17h2v2H7zm2 2h2v2H9zm6-2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-6-7h2v3H5zm12 0h2v3h-2zM3 6h2v8H3zm18 0h-2v8h2zM10 6h4v2h-4zM8 8h2v4H8zm2 4h4v2h-4zm4-4h2v4h-2z'
);
export const Play = /* @__PURE__ */ icon(
  'M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z'
);
export const Plus = /* @__PURE__ */ icon('M13 11h7v2h-7v7h-2v-7H4v-2h7V4h2v7Z');
export const RefreshCw = /* @__PURE__ */ icon(
  'M13 20H9V18H13V20ZM19 16H21V18H19V20H17V18H15V16H17V8H19V16ZM9 18H7V16H9V18ZM7 6H9V8H7V16H5V8H3V6H5V4H7V6ZM15 16H13V14H15V16ZM23 16H21V14H23V16ZM3 10H1V8H3V10ZM11 10H9V8H11V10ZM17 8H15V6H17V8ZM15 6H11V4H15V6Z'
);
export const Search = /* @__PURE__ */ icon(
  'M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z'
);
export const Settings2 = /* @__PURE__ */ icon(
  'M4 14h2v6H4zm6 0h2v6h-2zm-4-2h4v2H6zm0 8h4v2H6zm-4-4h2v2H2zm20-8h-4V6h4z M10 16h12v2H10zm4-8H2V6h12zm6-4v2h-2V4zm0 6V8h-2v2zm-6-8h4v2h-4zm0 10h4v-2h-4zm-2-8h2v2h-2zm0 6h2V8h-2z'
);
export const Share2 = /* @__PURE__ */ icon(
  'M20 22H4V20H20V22ZM4 20H2V14H4V20ZM22 20H20V14H22V20ZM13 4H15V6H17V8H13V18H11V8H7V6H9V4H11V2H13V4ZM9 14H4V12H9V14ZM20 14H15V12H20V14Z'
);
export const ShieldCheck = /* @__PURE__ */ icon(
  'M4 2h16v2H4zM2 4h2v10H2zm18 0h2v10h-2zM4 14h2v2H4zm2 2h2v2H6zm4 4h4v2h-4zm10-6h-2v2h2zm-2 2h-2v2h2zm-2 2h-2v2h2zm-6 0H8v2h2z'
);
export const SlidersHorizontal = /* @__PURE__ */ icon(
  'M17 18h5v2h-5v2h-2v-6h2v2Zm-4 2H2v-2h11v2Zm-4-5H7v-2H2v-2h5V9h2v6Zm13-2H11v-2h11v2Zm-7-9h7v2h-7v2h-2V2h2v2Zm-4 2H2V4h9v2Z'
);
export const Sparkles = /* @__PURE__ */ icon(
  'M11 1h2v4h-2zm0 22h2v-4h-2zM9 5h2v4H9zm0 14h2v-4H9zm4-14h2v4h-2zm0 14h2v-4h-2zM5 9h4v2H5zm14 0h-4v2h4zM1 11h4v2H1zm22 0h-4v2h4zM5 13h4v2H5zm14 0h-4v2h4zm0-12h2v6h-2z M17 3h6v2h-6zM3 17h2v2H3zm-2 2h2v2H1zm2 2h2v2H3zm2-2h2v2H5z'
);
export const Square = /* @__PURE__ */ icon('M20 20H4V4H20V20ZM6 18H18V6H6V18ZM14 14H10V10H14V14Z');
export const Sun = /* @__PURE__ */ icon(
  'M13 22h-2v-3h2v3Zm-6-3H5v-2h2v2Zm12 0h-2v-2h2v2Zm-4-2H9v-2h6v2Zm-6-2H7V9h2v6Zm8 0h-2V9h2v6ZM5 13H2v-2h3v2Zm17 0h-3v-2h3v2Zm-7-4H9V7h6v2ZM7 7H5V5h2v2Zm12 0h-2V5h2v2Zm-6-2h-2V2h2v3Z'
);
export const TextSelect = /* @__PURE__ */ icon(
  'M5 2h4v2H5zm0 20h4v-2H5zM9 4h2v2H9zm0 16h2v-2H9zm4-16h2v2h-2zm0 16h2v-2h-2zm2-18h4v2h-4zm0 20h4v-2h-4zM11 6h2v12h-2z'
);
export const VolumeX = /* @__PURE__ */ icon(
  'M13 22h-2v-2H9v-2h2V6H9V4h2V2h2v20Zm-4-4H7v-2h2v2Zm-2-8H5v4h2v2H3V8h4v2Zm10.001 5.224h-2v-2H17v-2h-1.999v-2h2v2H19v2h-1.999v2Zm3.999 0h-2v-2h2v2Zm0-4h-2v-2h2v2ZM9 8H7V6h2v2Z'
);
export const X = /* @__PURE__ */ icon(
  'M7 19H5V17H7V19ZM19 19H17V17H19V19ZM9 15V17H7V15H9ZM17 17H15V15H17V17ZM11 15H9V13H11V15ZM15 15H13V13H15V15ZM13 13H11V11H13V13ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM9 9H7V7H9V9ZM17 9H15V7H17V9ZM7 7H5V5H7V7ZM19 7H17V5H19V7Z'
);

/* Original glyphs drawn on the same 24-pixel grid. */
export const Cog = /* @__PURE__ */ icon(
  'M10 2h4v3h-4zM10 19h4v3h-4zM2 10h3v4H2zM19 10h3v4h-3zM5 5h3v3H5zM16 5h3v3h-3zM5 16h3v3H5zM16 16h3v3h-3zM7 6h10v2H7zM7 16h10v2H7zM6 7h2v10H6zM16 7h2v10h-2zM8 8h8v2H8zM8 14h8v2H8zM8 10h2v4H8zM14 10h2v4h-2z'
);
export const Monitor = /* @__PURE__ */ icon(
  'M2 3h20v2H2zM2 5h2v10H2zM20 5h2v10h-2zM2 15h20v2H2zM10 17h4v2h-4zM6 19h12v2H6z'
);
export const House = /* @__PURE__ */ icon(
  'M11 2h2v2h-2zM9 4h2v2H9zM13 4h2v2h-2zM7 6h2v2H7zM15 6h2v2h-2zM5 8h2v2H5zM17 8h2v2h-2zM3 10h2v2H3zM19 10h2v2h-2zM5 12h2v10H5zM17 12h2v10h-2zM7 20h10v2H7zM10 15h4v5h-4z'
);
