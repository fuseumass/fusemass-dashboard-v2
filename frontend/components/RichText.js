// Text that admins write in the form builder (question labels, help text, the
// round's intro) with two kinds of links:
//   - [link text](https://…)  → a link reading "link text"
//   - a bare https://… address → a link, allowed to wrap so it can't overflow
// Only http(s) addresses become links, so a "javascript:" URL in a label can
// never be clicked.
const LINK_PATTERN =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g;

const linkStyle = { overflowWrap: "anywhere" };

export default function RichText({ text }) {
  if (!text) return null;
  const parts = [];
  let last = 0;
  for (const match of String(text).matchAll(LINK_PATTERN)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const href = match[2] || match[3];
    parts.push(
      <a
        key={match.index}
        className="link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={linkStyle}
      >
        {match[1] || href}
      </a>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// The same text with [link text](url) reduced to "link text", for places
// that show it as plain text (e.g. the review drawer, aria labels).
export function plainText(text) {
  return String(text || "").replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    "$1",
  );
}
