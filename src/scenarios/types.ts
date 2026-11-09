export interface Asset {
  id: string;
  description: string;
  code: string;
  symbol: string;
  dependsOn?: string[];
  repo?: number;
  language?: "Python" | "TypeScript";
  files?: Record<string, string>;
}
export interface Unit {
  name: string;
  query: string;
  contract: string;
  required: string[];
  test: string;
  dependsOn?: string[];
}
export interface Scenario {
  id: string;
  assets: Asset[];
  units: Unit[];
  joint?: string;
  bridge?: string;
  early?: boolean;
}
export const asset = (
  id: string,
  symbol: string,
  description: string,
  code: string,
  extra: Partial<Asset> = {},
): Asset => ({ id, symbol, description, code, ...extra });
export function noise(count: number, theme: string) {
  return Array.from({ length: count }, (_, i) =>
    asset(
      "display-" + i,
      "displayLabel" + i,
      theme + " display theme " + i,
      "export function displayLabel" +
        i +
        "(text: string) { return " +
        JSON.stringify(theme + " " + i + ": ") +
        " + text; }",
    ),
  );
}
export const testHeader = "import assert from 'node:assert/strict';\n";
