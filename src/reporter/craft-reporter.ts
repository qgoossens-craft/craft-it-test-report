import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult
} from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { TestEntry, ReportData, TestMetadata, ReporterOptions } from '../types';

class CraftReporter implements Reporter {
  private tests: TestEntry[] = [];
  private startTime: Date = new Date();
  private options: Required<ReporterOptions>;
  private outputDir: string;

  constructor(options: ReporterOptions = {}) {
    this.options = {
      outputDir: options.outputDir || 'craft-report',
      outputFile: options.outputFile || 'report.html',
      open: options.open ?? false,
      title: options.title || 'Craft Test Report',
      logo: options.logo || ''
    };
    this.outputDir = path.resolve(process.cwd(), this.options.outputDir);
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startTime = new Date();
    const totalTests = suite.allTests().length;
    console.log('');
    console.log(chalk.cyan('┌─────────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('│') + chalk.bold.white('  🧪 Craft Test Report                                       ') + chalk.cyan('│'));
    console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));
    console.log(chalk.gray(`  Running ${chalk.white.bold(totalTests)} tests...\n`));
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const metadata = this.extractMetadata(test);

    const entry: TestEntry = {
      testId: test.id,
      name: test.title,
      fullTitle: test.titlePath().join(' > '),
      status: result.status,
      duration: result.duration,
      errorTrace: this.formatErrors(result.errors),
      metadata,
      filePath: test.location.file,
      line: test.location.line,
      startTime: result.startTime.toISOString(),
      retries: result.retry
    };

    // Replace existing test entry if this is a retry (keep only the latest run)
    const existingIndex = this.tests.findIndex(t => t.testId === test.id);
    if (existingIndex !== -1) {
      this.tests[existingIndex] = entry;
    } else {
      this.tests.push(entry);
    }

    // Log progress with colors
    const retryInfo = result.retry > 0 ? chalk.gray(` (retry #${result.retry})`) : '';
    const duration = chalk.gray(` ${(result.duration / 1000).toFixed(1)}s`);

    let output: string;
    switch (result.status) {
      case 'passed':
        output = `  ${chalk.green('✓')} ${chalk.green(test.title)}${retryInfo}${duration}`;
        break;
      case 'failed':
      case 'timedOut':
        output = `  ${chalk.red('✗')} ${chalk.red(test.title)}${retryInfo}${duration}`;
        break;
      case 'skipped':
        output = `  ${chalk.yellow('○')} ${chalk.yellow(test.title)}${retryInfo}${duration}`;
        break;
      default:
        output = `  ${chalk.gray('?')} ${chalk.gray(test.title)}${retryInfo}${duration}`;
    }
    console.log(output);
  }

  private extractMetadata(test: TestCase): TestMetadata {
    const metadata: TestMetadata = {};
    const annotations = test.annotations;

    for (const annotation of annotations) {
      const type = annotation.type.toLowerCase();
      const value = annotation.description || '';

      switch (type) {
        case 'epic':
          metadata.epic = value;
          break;
        case 'feature':
          metadata.feature = value;
          break;
        case 'story':
          metadata.story = value;
          break;
        case 'suite':
          metadata.suite = value;
          break;
        case 'subsuite':
          metadata.subSuite = value;
          break;
        case 'parentsuite':
          metadata.parentSuite = value;
          break;
        case 'severity':
          metadata.severity = value as TestMetadata['severity'];
          break;
        case 'owner':
          metadata.owner = value;
          break;
        case 'tag':
          metadata.tags = metadata.tags || [];
          metadata.tags.push(value);
          break;
        case 'description':
          metadata.description = value;
          break;
        default:
          // Store unknown annotations as parameters
          if (value) {
            metadata.parameters = metadata.parameters || {};
            metadata.parameters[type] = value;
          }
      }
    }

    // Extract suite hierarchy from titlePath if not set via annotations
    const titlePath = test.titlePath();
    if (titlePath.length > 1) {
      // First element is usually the file name, use describe blocks for suite hierarchy
      if (!metadata.parentSuite && titlePath.length > 1) {
        metadata.parentSuite = titlePath[0];
      }
      if (!metadata.suite && titlePath.length > 2) {
        metadata.suite = titlePath[1];
      }
      if (!metadata.subSuite && titlePath.length > 3) {
        metadata.subSuite = titlePath[2];
      }
    }

    return metadata;
  }

  private formatErrors(errors: TestResult['errors']): string | undefined {
    if (!errors || errors.length === 0) return undefined;

    return errors
      .map((error) => {
        let message = error.message || '';
        if (error.stack) {
          message += '\n' + error.stack;
        }
        return message;
      })
      .join('\n---\n');
  }

  async onEnd(result: FullResult): Promise<void> {
    const duration = Date.now() - this.startTime.getTime();

    // Sort tests by name using natural sort (handles numbers correctly: 001, 002, 010)
    this.tests.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    const reportData: ReportData = {
      timestamp: new Date().toISOString(),
      totalTests: this.tests.length,
      passed: this.tests.filter((t) => t.status === 'passed').length,
      failed: this.tests.filter((t) => t.status === 'failed' || t.status === 'timedOut').length,
      skipped: this.tests.filter((t) => t.status === 'skipped').length,
      duration,
      tests: this.tests,
      comments: this.loadExistingComments()
    };

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // Generate HTML report
    await this.generateHTMLReport(reportData);

    // Save JSON data
    const jsonPath = path.join(this.outputDir, 'report-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(reportData, null, 2));

    // Summary with colors
    console.log('');
    console.log(chalk.cyan('┌─────────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('│') + chalk.bold.white('  📊 Test Results                                            ') + chalk.cyan('│'));
    console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));

    const statusIcon = result.status === 'passed' ? chalk.green('✓') : chalk.red('✗');
    const statusText = result.status === 'passed' ? chalk.green.bold('PASSED') : chalk.red.bold('FAILED');
    console.log(`  ${statusIcon} Status:   ${statusText}`);
    console.log(`  📋 Total:    ${chalk.white.bold(reportData.totalTests)}`);
    console.log(`  ${chalk.green('✓')} Passed:   ${chalk.green.bold(reportData.passed)}`);
    console.log(`  ${chalk.red('✗')} Failed:   ${chalk.red.bold(reportData.failed)}`);
    console.log(`  ${chalk.yellow('○')} Skipped:  ${chalk.yellow.bold(reportData.skipped)}`);
    console.log(`  ⏱️  Duration: ${chalk.white.bold((duration / 1000).toFixed(2) + 's')}`);
    console.log('');
    console.log(chalk.cyan('  📄 Report: ') + chalk.underline.white(path.join(this.outputDir, this.options.outputFile)));
    console.log('');

    // Open in browser if requested
    if (this.options.open) {
      const reportPath = path.join(this.outputDir, this.options.outputFile);
      const { exec } = await import('child_process');
      const command = process.platform === 'darwin'
        ? `open "${reportPath}"`
        : process.platform === 'win32'
          ? `start "" "${reportPath}"`
          : `xdg-open "${reportPath}"`;
      exec(command);
    }
  }

  private loadExistingComments(): Record<string, string> {
    const commentsPath = path.join(this.outputDir, 'comments.json');
    if (fs.existsSync(commentsPath)) {
      try {
        return JSON.parse(fs.readFileSync(commentsPath, 'utf-8'));
      } catch {
        return {};
      }
    }
    return {};
  }

  private async generateHTMLReport(data: ReportData): Promise<void> {
    const templatePath = path.join(__dirname, '../html/template.html');
    const cssPath = path.join(__dirname, '../html/styles.css');
    const jsPath = path.join(__dirname, '../html/report.js');

    let template: string;
    let css: string;
    let js: string;

    // Read template files
    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, 'utf-8');
      css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf-8') : '';
      js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf-8') : '';
    } else {
      // Fallback: try from src directory (development mode)
      const srcTemplatePath = path.join(__dirname, '../../src/html/template.html');
      const srcCssPath = path.join(__dirname, '../../src/html/styles.css');
      const srcJsPath = path.join(__dirname, '../../src/html/report.js');

      template = fs.existsSync(srcTemplatePath)
        ? fs.readFileSync(srcTemplatePath, 'utf-8')
        : this.getDefaultTemplate();
      css = fs.existsSync(srcCssPath) ? fs.readFileSync(srcCssPath, 'utf-8') : '';
      js = fs.existsSync(srcJsPath) ? fs.readFileSync(srcJsPath, 'utf-8') : '';
    }

    // Generate logo HTML if logo option is set
    let logoHtml = '';
    if (this.options.logo) {
      const logoPath = path.resolve(process.cwd(), this.options.logo);
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        const logoBase64 = logoBuffer.toString('base64');
        const ext = path.extname(logoPath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
        logoHtml = `<img src="data:${mimeType};base64,${logoBase64}" alt="Logo">`;
      }
    }

    // Inject data, CSS, JS, and logo into template
    const html = template
      .replace('/* INJECT_STYLES */', css)
      .replace('/* INJECT_SCRIPT */', js)
      .replace('/* INJECT_DATA */', JSON.stringify(data))
      .replace(/\{\{TITLE\}\}/g, this.options.title)
      .replace('<!-- INJECT_LOGO -->', logoHtml);

    const outputPath = path.join(this.outputDir, this.options.outputFile);
    fs.writeFileSync(outputPath, html);
  }

  private getDefaultTemplate(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{TITLE}}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>/* INJECT_STYLES */</style>
</head>
<body>
  <div id="app">Loading report...</div>
  <script>
    const REPORT_DATA = /* INJECT_DATA */;
    /* INJECT_SCRIPT */
  </script>
</body>
</html>`;
  }
}

export default CraftReporter;
