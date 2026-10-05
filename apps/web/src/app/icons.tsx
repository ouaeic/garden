import type { ReactElement, SVGProps } from 'react';

/** One stroke family for the whole interface, drawn on a 24-unit grid. */
type Icon = (props: SVGProps<SVGSVGElement>) => ReactElement;

const stroke = (paths: ReactElement, width = 1.7): Icon =>
  function StrokeIcon(props) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };

export const Sprout = stroke(
  <>
    <path d="M12 21v-8" />
    <path d="M12 13c0-4 2.8-6.8 7.3-6.8 0 4-2.9 6.8-7.3 6.8zM12 15.5c0-3.4-2.3-5.6-6.2-5.6 0 3.3 2.4 5.6 6.2 5.6z" />
  </>
);
export const Tune = stroke(
  <>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </>
);
export const Bloom = stroke(
  <>
    <circle cx="12" cy="12" r="2.4" />
    <path d="M12 9.6c-1.6-2.2-1.6-4.6 0-6.1 1.6 1.5 1.6 3.9 0 6.1zM12 14.4c1.6 2.2 1.6 4.6 0 6.1-1.6-1.5-1.6-3.9 0-6.1zM9.6 12c-2.2 1.6-4.6 1.6-6.1 0 1.5-1.6 3.9-1.6 6.1 0zM14.4 12c2.2-1.6 4.6-1.6 6.1 0-1.5 1.6-3.9 1.6-6.1 0z" />
  </>,
  1.6
);
export const Spend = stroke(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M14.6 9.3c-.6-.8-1.5-1.3-2.7-1.3-1.6 0-2.7.9-2.7 2s1 1.7 2.7 2 2.8.9 2.8 2.1-1.2 2-2.8 2c-1.2 0-2.2-.5-2.8-1.3M12 6.4V8M12 16v1.6" />
  </>
);
export const Speak = stroke(
  <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
);
export const Publish = stroke(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16M12 4c2.4 2.3 3.6 5 3.6 8s-1.2 5.7-3.6 8c-2.4-2.3-3.6-5-3.6-8S9.6 6.3 12 4z" />
  </>
);
export const Remove = stroke(<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />);
export const Rules = stroke(
  <>
    <rect x="4" y="4.5" width="16" height="15" rx="2" />
    <path d="M8 9h8M8 12.5h8M8 16h5" />
  </>
);
export const Lock = stroke(
  <>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </>
);
export const Key = stroke(
  <>
    <circle cx="8" cy="12" r="3.5" />
    <path d="M11.5 12H20M17 12v3M20 12v2" />
  </>
);
export const Check = stroke(<path d="M5 12.5l4.5 4.5L19 7.5" />, 2.6);
export const Question = stroke(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 2-2.2 3.4M12 16.8v.2" />
  </>,
  1.8
);
export const Play = stroke(<path d="M8 5.5v13l11-6.5z" fill="currentColor" />);
export const Pause = stroke(
  <>
    <path d="M8.5 5.5v13M15.5 5.5v13" />
  </>,
  2.4
);
export const Back = stroke(<path d="M14.5 6l-6 6 6 6" />, 1.8);
export const Close = stroke(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />, 1.8);
export const Eye = stroke(
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </>
);
export const Up = stroke(<path d="M12 19V5M6 11l6-6 6 6" />, 2);
export const Mic = stroke(
  <>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </>
);
export const Paperclip = stroke(
  <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
);
export const Search = stroke(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>
);
export const Settings = stroke(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>,
  1.5
);
export const Theme = stroke(
  <>
    <circle cx="12" cy="12" r="7.5" />
    <path d="M12 4.5v15a7.5 7.5 0 0 0 0-15z" fill="currentColor" />
  </>
);
export const Screen = stroke(
  <>
    <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </>
);
export const Terminal = stroke(
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
  </>
);
export const Folder = stroke(
  <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
);
export const Stop = stroke(<rect x="6.5" y="6.5" width="11" height="11" rx="2" />);
export const Refresh = stroke(<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />);
export const More = stroke(
  <>
    <circle cx="6" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="18" cy="12" r="1" fill="currentColor" />
  </>
);
export const External = stroke(
  <path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />
);
