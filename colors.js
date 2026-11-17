// Keep account names neutral. Color dashboard window/value pairs and each
// number in a compact 5h:W:M triplet independently.
function colorFor(value) {
  return value < 10 ? "#ff6b6b" : value < 30 ? "#facc15" : undefined;
}

function labeledParts(text) {
  const pattern = /((?:\d+(?:m|h|d)|W|M):\d+(?:\.\d+)?%?)/g;
  return text.split(pattern).filter(Boolean).map((part) => {
    const match = /^(?:(?:\d+(?:m|h|d)|W|M):)(\d+(?:\.\d+)?)%?$/.exec(part);
    return { text: part, color: match ? colorFor(Number(match[1])) : undefined };
  });
}

export function percentageParts(text) {
  const triplets = /(^| · )([A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)?) ((?:\d+|-|\?):(?:\d+|-|\?):(?:\d+|-|\?))(~*)/g;
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(triplets)) {
    const start = match.index;
    parts.push(...labeledParts(text.slice(cursor, start)));
    parts.push({ text: `${match[1]}${match[2]} `, color: undefined });
    match[3].split(":").forEach((value, index) => {
      if (index) parts.push({ text: ":", color: undefined });
      const numeric = /^-?\d+$/.test(value) ? Number(value) : undefined;
      parts.push({ text: value, color: numeric === undefined ? undefined : colorFor(numeric) });
    });
    if (match[4]) parts.push({ text: match[4], color: undefined });
    cursor = start + match[0].length;
  }
  parts.push(...labeledParts(text.slice(cursor)));
  return parts;
}
