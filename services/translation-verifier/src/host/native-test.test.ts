import { describe, expect, it } from 'vitest';
import { parseGcovReports } from './native-test.js';

describe('native coverage identity', () => {
  const report = JSON.stringify([{ current_working_directory: process.cwd(), files: [
    { file: 'price.cpp', functions: [
      { name: '_Z3int', demangled_name: 'shop::Price::calculate(int)', start_line: 4, execution_count: 1 },
      { name: '_Z6double', demangled_name: 'shop::Price::calculate(double)', start_line: 8, execution_count: 0 },
    ], lines: [
      { function_name: '_Z3int', line_number: 4, count: 1, branches: [{ count: 1 }, { count: 0 }] },
      { function_name: '_Z6double', line_number: 8, count: 0 },
    ] },
    { file: 'other/price.cpp', functions: [{ name: 'calculate', start_line: 8, execution_count: 100 }], lines: [] },
  ] }]);
  it('uses the actual declaration location to distinguish overloads and never borrows same-named files', () => {
    expect(parseGcovReports(report, process.cwd(), { path: 'price.cpp', name: 'calculate', signature: 'shop.Price.calculate(double x)', startLine: 8 }))
      .toEqual({ name: 'calculate', executed: false, lineCoverage: 0, branchCoverage: null });
    expect(parseGcovReports(report, process.cwd(), { path: 'price.cpp', name: 'calculate', startLine: 4 }))
      .toMatchObject({ executed: true, branchCoverage: 50 });
  });
  it('rejects ambiguous overloads, missing functions and invalid reports', () => {
    expect(() => parseGcovReports(report, process.cwd(), { path: 'price.cpp', name: 'calculate' })).toThrow('uniquely');
    expect(() => parseGcovReports(report, process.cwd(), { path: 'missing.cpp', name: 'calculate' })).toThrow('0 matches');
    expect(() => parseGcovReports('{}', process.cwd(), { path: 'price.cpp', name: 'calculate' })).toThrow('Invalid');
  });
});
