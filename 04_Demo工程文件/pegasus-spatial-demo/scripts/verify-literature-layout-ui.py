#!/usr/bin/env python3
"""Local Playwright regression for the compact scientific paper layout."""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", default="Researcher")
    parser.add_argument("--project-text", required=True)
    parser.add_argument("--paper-query", required=True)
    parser.add_argument("--expected-section", required=True)
    parser.add_argument("--front-matter-text", required=True)
    parser.add_argument("--base-url", default="http://localhost:3200")
    parser.add_argument(
        "--screenshot",
        default=str(Path(tempfile.gettempdir()) / "pegasus-spatial-literature-layout.png"),
    )
    args = parser.parse_args()

    console_errors: list[str] = []
    failed_responses: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1680, "height": 1050})
        page = context.new_page()
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("response", lambda response: failed_responses.append(f"{response.status} {response.url}") if response.status >= 400 else None)
        page.goto(args.base_url, wait_until="networkidle")

        project = page.locator(".pmo-project", has_text=args.project_text).first
        project.wait_for(state="visible", timeout=15_000)
        project.click()

        filter_input = page.get_by_role("searchbox", name="筛选项目文件")
        filter_input.wait_for(state="visible", timeout=20_000)
        filter_input.fill(args.paper_query)
        fulltext = page.get_by_role("option").filter(has_text="结构化全文").first
        fulltext.wait_for(state="visible", timeout=10_000)
        fulltext.click()

        reader = page.get_by_test_id("literature-paper-reader")
        reader.wait_for(state="visible", timeout=15_000)
        article = reader.locator("article")
        markdown = reader.locator('[data-testid="scientific-markdown"][data-variant="article"]')
        paragraph = markdown.locator("p").first
        section = markdown.get_by_role("heading", name=args.expected_section, exact=True).first
        section.wait_for(state="visible", timeout=10_000)

        metrics = page.evaluate(
            """([article, markdown, paragraph]) => {
              const style = getComputedStyle(paragraph)
              return {
                articleWidth: article.getBoundingClientRect().width,
                markdownWidth: markdown.getBoundingClientRect().width,
                fontSize: parseFloat(style.fontSize),
                lineHeight: parseFloat(style.lineHeight),
                fontFamily: style.fontFamily,
                pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              }
            }""",
            [article.element_handle(), markdown.element_handle(), paragraph.element_handle()],
        )
        assert metrics["articleWidth"] <= 822, metrics
        assert metrics["markdownWidth"] < metrics["articleWidth"], metrics
        assert 13 <= metrics["fontSize"] <= 14.5, metrics
        assert 1.6 <= metrics["lineHeight"] / metrics["fontSize"] <= 1.78, metrics
        assert "Avenir" not in metrics["fontFamily"], metrics
        assert metrics["pageOverflow"] <= 1, metrics
        assert reader.locator("h1").count() == 1, "PaperHeader must be the sole document H1"
        assert markdown.locator("h1").count() == 0, "provider headings must be article sections"

        disclosure = reader.get_by_test_id("publisher-front-matter")
        assert disclosure.count() == 1
        assert disclosure.get_attribute("open") is None
        assert not disclosure.get_by_text(args.front_matter_text, exact=False).is_visible()
        disclosure.locator("summary").click()
        disclosure.get_by_text(args.front_matter_text, exact=False).wait_for(state="visible", timeout=5_000)
        disclosure.locator("summary").click()

        screenshot_path = Path(args.screenshot)
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot_path), full_page=True)

        unexpected_responses = [item for item in failed_responses if "/files?path=" not in item]
        assert not unexpected_responses, f"unexpected failed responses: {unexpected_responses}"
        unexpected_console = [item for item in console_errors if "404 (Not Found)" not in item]
        assert not unexpected_console, f"browser console errors: {unexpected_console}"
        context.close()
        browser.close()

    print(f"literature-layout-ui:verify passed metrics={metrics} screenshot={args.screenshot}")


if __name__ == "__main__":
    main()
