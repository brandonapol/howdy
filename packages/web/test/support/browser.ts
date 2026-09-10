import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

const EXECUTABLE = process.env["HOWDY_CHROMIUM"];

export const launch = (): Promise<Browser> =>
  chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE });

export type Session = {
  readonly page: Page;
  readonly errors: readonly string[];
  readonly close: () => Promise<void>;
};

export const openApp = async (browser: Browser, url: string): Promise<Session> => {
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app");
  return { page, errors, close: () => page.close() };
};
