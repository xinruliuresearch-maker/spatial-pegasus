#!/usr/bin/env python3
"""Local-only Playwright smoke test for the Workspace Explorer."""

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
    parser.add_argument("--base-url", default="http://localhost:3200")
    parser.add_argument(
        "--screenshot",
        default=str(Path(tempfile.gettempdir()) / "pegasus-spatial-workspace-explorer.png"),
    )
    args = parser.parse_args()

    errors: list[str] = []
    failed_responses: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1680, "height": 1050})
        page = context.new_page()
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.on("response", lambda response: failed_responses.append(f"{response.status} {response.url}") if response.status >= 400 else None)
        page.goto(args.base_url, wait_until="networkidle")

        project = page.locator(".pmo-project", has_text=args.project_text).first
        project.wait_for(state="visible", timeout=15_000)
        project.click()

        explorer = page.get_by_test_id("workspace-file-explorer")
        explorer.wait_for(state="visible", timeout=20_000)
        assert page.get_by_role("tab", name="文件").get_attribute("aria-selected") == "true"
        assert page.locator("header nav[aria-label='当前文件路径']").count() == 1
        assert page.locator("header nav[aria-label='当前文件路径']").locator("button").count() == 0

        filter_input = page.get_by_role("searchbox", name="筛选项目文件")
        filter_input.fill("62d840")
        results = page.get_by_role("option")
        results.first.wait_for(state="visible", timeout=10_000)
        fulltext_result = results.filter(has_text="结构化全文").first
        fulltext_result.wait_for(state="visible", timeout=10_000)
        fulltext_result.click()
        page.locator("header nav[aria-label='当前文件路径']").get_by_text("source-fulltext.md", exact=True).wait_for(timeout=10_000)

        reader = page.get_by_test_id("literature-paper-reader")
        reader.wait_for(state="visible", timeout=15_000)
        reader.get_by_text("结构化全文 · 重排版", exact=False).wait_for(timeout=10_000)
        title = reader.locator("header h1").inner_text().strip()
        assert title.casefold().startswith("new insights of oral colonic drug delivery systems"), title
        assert reader.locator(".katex").count() > 0, "scientific formula should render through KaTeX"
        assert reader.locator("table").count() > 0, "publisher table should render as a table"
        proxy_images = reader.locator("img[src*='/literature/resource']")
        assert proxy_images.count() > 0, "relative Sciverse figures should use the authenticated resource proxy"
        reader.evaluate("element => element.querySelector(\"img[src*='/literature/resource']\")?.scrollIntoView({ block: 'center' })")
        page.wait_for_timeout(1500)

        reader.get_by_role("button", name="论文信息").click()
        reader.get_by_role("heading", name="论文信息", exact=True).wait_for(timeout=10_000)
        assert reader.locator("pre").count() == 0, "paper metadata should not be shown as raw JSON"
        reader.get_by_role("button", name="来源记录").click()
        reader.get_by_role("heading", name="来源与溯源", exact=True).wait_for(timeout=10_000)
        reader.get_by_role("button", name="论文阅读版").click()

        filter_input.fill("")
        tree = explorer.get_by_role("tree")
        tree.wait_for(state="visible", timeout=10_000)
        tree_items = tree.get_by_role("treeitem")
        assert tree_items.count() > 1, "keyboard navigation requires at least two visible tree items"
        layout = explorer.evaluate("""element => {
          const bounds = element.getBoundingClientRect()
          const rows = [...element.querySelectorAll('[role="treeitem"]')].map(row => row.getBoundingClientRect())
          const labels = [...element.querySelectorAll('[role="treeitem"] [data-path]')]
          return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            maxRowRight: Math.max(...rows.map(row => row.right)),
            explorerRight: bounds.right,
            hasTruncatedLabel: labels.some(label => {
              const style = getComputedStyle(label)
              return label.scrollWidth > label.clientWidth + 1 && style.textOverflow === 'ellipsis'
            }),
          }
        }""")
        assert layout["scrollWidth"] <= layout["clientWidth"] + 1, layout
        assert layout["maxRowRight"] <= layout["explorerRight"] + 1, layout
        assert layout["hasTruncatedLabel"], "at least one long paper title should use a visible ellipsis"
        assert tree.locator('[role="treeitem"][title]').count() == 0, "tree rows must not open path-sized native tooltips"
        first_tree_item = tree_items.first
        first_tree_item.focus()
        before = page.evaluate("document.activeElement?.getAttribute('aria-label')")
        first_tree_item.press("ArrowDown")
        page.wait_for_timeout(80)
        after = page.evaluate("document.activeElement?.getAttribute('aria-label')")
        assert before and after and before != after, (
            f"ArrowDown should move tree focus (before={before!r}, after={after!r})"
        )

        screenshot_path = Path(args.screenshot)
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot_path), full_page=True)
        unexpected_responses = [
            item for item in failed_responses
            if "/files?path=" not in item
        ]
        assert not unexpected_responses, f"unexpected failed responses: {unexpected_responses}"
        unexpected_console = [item for item in errors if "404 (Not Found)" not in item]
        assert not unexpected_console, f"browser console errors: {unexpected_console}"
        context.close()
        browser.close()

    suffix = f" nonfatal_failed_responses={failed_responses}" if failed_responses else ""
    print(f"workspace-explorer-ui:verify passed screenshot={args.screenshot}{suffix}")


if __name__ == "__main__":
    main()
