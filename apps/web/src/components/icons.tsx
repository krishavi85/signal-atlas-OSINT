'use client';

/**
 * Minimal dependency-free icon set (stroke-based, 24x24 viewBox, currentColor).
 * Kept inline rather than pulling an icon package — a dozen glyphs don't
 * justify a dependency, and this keeps the bundle small.
 */
type IconProps = { className?: string; size?: number };

function base(paths: React.ReactNode) {
  return function Icon({ className = 'h-4 w-4', size }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        width={size}
        height={size}
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };
}

export const IconHome = base(<path d="M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />);

export const IconSearch = base(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
);

export const IconZap = base(<path d="M12 2 4 14h6l-1 8 9-13h-6l1-7Z" strokeLinejoin="round" />);

export const IconFolder = base(<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />);

export const IconPlug = base(
  <>
    <path d="M9 2v5M15 2v5M7 9h10v3a5 5 0 0 1-5 5v0a5 5 0 0 1-5-5V9Z" />
    <path d="M12 17v5" />
  </>,
);

export const IconSettings = base(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </>,
);

export const IconChevronDown = base(<path d="m6 9 6 6 6-6" />);
export const IconChevronRight = base(<path d="m9 6 6 6-6 6" />);
export const IconPlus = base(<path d="M12 5v14M5 12h14" />);
export const IconArrowRight = base(<path d="M5 12h14M13 5l7 7-7 7" />);
export const IconArrowUpRight = base(<path d="M7 17 17 7M8 7h9v9" />);

export const IconAlertTriangle = base(
  <>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </>,
);

export const IconCheckCircle = base(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.5 2.5 5-5" />
  </>,
);

export const IconClock = base(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </>,
);

export const IconFileText = base(
  <>
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M14 3v4h4M9 12h6M9 16h6M9 8h2" />
  </>,
);

export const IconUsers = base(
  <>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16.5 5.5a3.2 3.2 0 0 1 0 6M20 20a6.2 6.2 0 0 0-4.5-6" />
  </>,
);

export const IconLink = base(
  <>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M11 6.5 13 4.5a3.6 3.6 0 0 1 5 5l-2 2M13 17.5l-2 2a3.6 3.6 0 0 1-5-5l2-2" />
  </>,
);

export const IconImage = base(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m21 15-5-5-9 9" />
  </>,
);

export const IconBell = base(<path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6ZM9.5 18a2.5 2.5 0 0 0 5 0" />);

export const IconShield = base(<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />);

export const IconRadar = base(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" strokeOpacity={0.5} />
    <path d="M12 12 19 7" />
  </>,
);

export const IconDatabase = base(
  <>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5V18c0 1.7 3.6 3 8 3s8-1.3 8-3V5.5" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </>,
);

export const IconSparkle = base(
  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4Z" />,
);

export const IconInbox = base(
  <>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
  </>,
);

export const IconLogout = base(
  <>
    <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </>,
);

export const IconFingerprint = base(
  <>
    <path d="M12 3a7 7 0 0 0-7 7c0 2.5.5 4.5 1.5 6" />
    <path d="M12 3a7 7 0 0 1 7 7c0 1 0 2-.2 3" />
    <path d="M8.5 20a10 10 0 0 1-1.8-4.5M15.5 20a13 13 0 0 0 1.8-6.5" />
    <path d="M12 7a3.5 3.5 0 0 0-3.5 3.5c0 3-1 5.5-2.2 7.2" />
    <path d="M12 7a3.5 3.5 0 0 1 3.5 3.5c0 1.2-.1 2.2-.3 3.1" />
    <path d="M12 10.5v3c0 2.2-.6 4.1-1.6 5.7" />
  </>,
);
