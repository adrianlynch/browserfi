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
  ["#EF4444", "red"],
  ["#F97316", "orange"],
  ["#EAB308", "yellow"],
  ["#22C55E", "green"],
  ["#14B8A6", "teal"],
  ["#06B6D4", "cyan"],
  ["#3B82F6", "blue"],
  ["#8B5CF6", "violet"],
  ["#EC4899", "pink"],
  ["#64748B", "slate"],
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
  for (const [hex, label] of colors) {
    console.log(`${swatch(hex)}  ${hex.padEnd(8)} ${label}`);
  }
}

console.log("Browserfi terminal color samples");
printSection("Current picker colors", currentColors);
printSection("Suggested additions", suggestedColors);
console.log("");
