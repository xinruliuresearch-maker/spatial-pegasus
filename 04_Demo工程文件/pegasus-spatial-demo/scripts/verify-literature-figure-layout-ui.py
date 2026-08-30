#!/usr/bin/env python3
"""Local Playwright regression for Sciverse multi-panel figures."""

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
    parser.add_argument("--paper-query", default="73a70")
    parser.add_argument("--base-url", default="http://localhost:3200")
    parser.add_argument(
        "--screenshot",
        default=str(Path(tempfile.gettempdir()) / "pegasus-spatial-figure-layout.png"),
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
        cluster = reader.locator('[data-scientific-figure-cluster][data-scientific-figure-count="7"]').first
        cluster.wait_for(state="visible", timeout=15_000)
        page.wait_for_timeout(750)
        cluster = reader.locator('[data-scientific-figure-cluster][data-scientific-figure-count="7"]').first
        cluster.evaluate("element => element.scrollIntoView({ block: 'center' })")
        cluster.locator("img").last.wait_for(state="visible", timeout=20_000)
        page.wait_for_function(
            """element => [...element.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0)""",
            arg=cluster.element_handle(),
            timeout=30_000,
        )

        metrics = cluster.evaluate("""element => {
          const clusterRect = element.getBoundingClientRect()
          const images = [...element.querySelectorAll('img')].map(image => {
            const rect = image.getBoundingClientRect()
            return {
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              renderedWidth: rect.width,
              renderedHeight: rect.height,
              shape: image.closest('[data-scientific-figure-panel]')?.getAttribute('data-shape'),
            }
          })
          return {
            count: images.length,
            width: clusterRect.width,
            height: clusterRect.height,
            images,
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            rawBrokenTailVisible: document.body.innerText.includes('ge/dt=2026-03-19/ht=13//'),
          }
        }""")
        assert metrics["count"] == 7, metrics
        assert metrics["height"] < 2_300, metrics
        assert metrics["pageOverflow"] <= 1, metrics
        assert not metrics["rawBrokenTailVisible"], metrics
        assert any(image["shape"] == "narrow" for image in metrics["images"]), metrics
        assert all(image["renderedWidth"] <= metrics["width"] + 1 for image in metrics["images"]), metrics
        narrow = next(image for image in metrics["images"] if image["shape"] == "narrow")
        assert narrow["renderedWidth"] <= 160, metrics
        assert narrow["renderedHeight"] > narrow["renderedWidth"] * 3, metrics

        screenshot_path = Path(args.screenshot)
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot_path), full_page=False)

        bad_resource_requests = [item for item in failed_responses if "ref=image" in item or "999e9e" in item]
        assert not bad_resource_requests, bad_resource_requests
        unexpected_responses = [item for item in failed_responses if "/files?path=" not in item]
        assert not unexpected_responses, f"unexpected failed responses: {unexpected_responses}"
        unexpected_console = [item for item in console_errors if "404 (Not Found)" not in item]
        assert not unexpected_console, f"browser console errors: {unexpected_console}"
        context.close()
        browser.close()

    print(f"literature-figure-layout-ui:verify passed metrics={metrics} screenshot={args.screenshot}")


if __name__ == "__main__":
    main()
