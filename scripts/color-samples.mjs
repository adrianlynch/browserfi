#!/usr/bin/env node

const currentColors = [
  ["default", "no color"],
  ["#34CDD7", "cyan / teal"],
  ["#FFB000", "amber"],
  ["#FF5C8A", "pink"],
  ["#7C5CFF", "purple"],
  ["#2ECC71", "green"],
  ["#FFFFFF", "white"],
  ["#111111", "near-black"],
];

const suggestedColors = [
  ["#FEE2E2", "red 100"],
  ["#FCA5A5", "red 300"],
  ["#EF4444", "red 500"],
  ["#B91C1C", "red 700"],
  ["#FFEDD5", "orange 100"],
  ["#FDBA74", "orange 300"],
  ["#F97316", "orange 500"],
  ["#C2410C", "orange 700"],
  ["#FEF3C7", "amber 100"],
  ["#FCD34D", "amber 300"],
  ["#F59E0B", "amber 500"],
  ["#B45309", "amber 700"],
  ["#FEF9C3", "yellow 100"],
  ["#FDE047", "yellow 300"],
  ["#EAB308", "yellow 500"],
  ["#A16207", "yellow 700"],
  ["#DCFCE7", "green 100"],
  ["#86EFAC", "green 300"],
  ["#22C55E", "green 500"],
  ["#15803D", "green 700"],
  ["#CCFBF1", "teal 100"],
  ["#5EEAD4", "teal 300"],
  ["#14B8A6", "teal 500"],
  ["#0F766E", "teal 700"],
  ["#CFFAFE", "cyan 100"],
  ["#67E8F9", "cyan 300"],
  ["#06B6D4", "cyan 500"],
  ["#0E7490", "cyan 700"],
  ["#DBEAFE", "blue 100"],
  ["#93C5FD", "blue 300"],
  ["#3B82F6", "blue 500"],
  ["#1D4ED8", "blue 700"],
  ["#E0E7FF", "indigo 100"],
  ["#A5B4FC", "indigo 300"],
  ["#6366F1", "indigo 500"],
  ["#4338CA", "indigo 700"],
  ["#EDE9FE", "violet 100"],
  ["#C4B5FD", "violet 300"],
  ["#8B5CF6", "violet 500"],
  ["#6D28D9", "violet 700"],
  ["#FCE7F3", "pink 100"],
  ["#F9A8D4", "pink 300"],
  ["#EC4899", "pink 500"],
  ["#BE185D", "pink 700"],
  ["#F8FAFC", "slate 50"],
  ["#CBD5E1", "slate 300"],
  ["#64748B", "slate 500"],
  ["#334155", "slate 700"],
  ["#FFFFFF", "white"],
  ["#111111", "near-black"],
];

const reset = "\x1b[0m";

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function swatch(hex) {
  if (!hex.startsWith("#")) return "          ";
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m          ${reset}`;
}

function printSection(title, colors) {
  console.log(`\n${title}`);
  console.log("".padEnd(title.length, "-"));
  for (const [hex, label] of colors.sort((a, b) => luminance(a[0]) - luminance(b[0]))) {
    console.log(`${swatch(hex)}  ${hex.padEnd(8)} ${label}`);
  }
}

function luminance(hex) {
  if (!hex.startsWith("#")) return -1;
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

console.log("Browserfi terminal color samples");
printSection("Current picker colors", currentColors);
printSection("Suggested additions", suggestedColors);
console.log("");
