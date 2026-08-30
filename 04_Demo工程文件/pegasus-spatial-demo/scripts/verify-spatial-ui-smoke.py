#!/usr/bin/env python3
"""Paid-call-free browser smoke for the single-user local Demo."""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


def open_and_verify_fixture(
    page: Page,
    base_url: str,
    conversation_id: str,
    conversation_title: str,
    job_id: str,
) -> None:
    job_status_url = f"{base_url}/api/conversations/{conversation_id}/spatial/jobs/{job_id}"
    with page.expect_response(
        lambda candidate: candidate.url == job_status_url,
        timeout=10_000,
    ) as status_response:
        page.get_by_text(conversation_title, exact=True).first.click()
    reconciled = status_response.value
    assert reconciled.status == 200
    assert reconciled.json()["job"]["status"] == "published"

    job_label = page.get_by_text(f"JOB {job_id}", exact=True)
    job_label.wait_for(state="attached")
    job_label.scroll_into_view_if_needed()
    job_label.wait_for(state="visible")
    page.get_by_text("空间世界", exact=True).wait_for(state="visible")
    page.get_by_text("已发布", exact=True).wait_for(state="visible")
    page.get_by_text("fixture-no-network", exact=True).wait_for(state="visible")
    page.get_by_text(
        "空间任务已经从本地持久记录恢复，并由 Job API 校准到已发布；本测试没有访问 Aholo、Lux3D 或图像供应商。",
        exact=True,
    ).wait_for(state="visible")

    card = job_label.locator("xpath=ancestor::section[1]")
    assert card.get_by_role("button").count() == 0
    response = page.request.get(job_status_url)
    assert response.status == 200
    payload = response.json()
    assert payload["job"]["job_id"] == job_id
    assert payload["job"]["status"] == "published"
    assert payload["job"]["provider"] == "fixture-no-network"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:3200")
    parser.add_argument(
        "--screenshot",
        default=str(Path(tempfile.gettempdir()) / "pegasus-spatial-demo.png"),
    )
    parser.add_argument("--fixture-conversation-id")
    parser.add_argument("--fixture-title")
    parser.add_argument("--fixture-job-id")
    parser.add_argument("--phase", choices=("public", "before-restart", "after-restart"), default="public")
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")

    console_errors: list[str] = []
    failed_responses: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on(
            "response",
            lambda response: failed_responses.append(f"{response.status} {response.url}")
            if response.status >= 400 else None,
        )
        page.goto(f"{base_url}/", wait_until="networkidle")
        assert page.title().startswith("Pegasus Spatial"), page.title()
        page.get_by_text("Pegasus Spatial", exact=True).first.wait_for(state="visible")
        page.get_by_text("本地演示", exact=True).wait_for(state="visible")
        page.get_by_role("button", name="新项目").first.wait_for(state="visible")
        desktop_overflow = page.evaluate(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        assert desktop_overflow <= 1

        # Direct access still scopes all data to the fixed local owner key.
        response = page.request.get(
            f"{base_url}/api/conversations/not-owned/spatial/jobs/not-owned"
        )
        assert response.status == 404, f"foreign spatial status={response.status}"

        fixture_args = (args.fixture_conversation_id, args.fixture_title, args.fixture_job_id)
        if any(fixture_args) and not all(fixture_args):
            raise RuntimeError("fixture arguments must be supplied together")
        if all(fixture_args):
            open_and_verify_fixture(page, base_url, *fixture_args)
            page.reload(wait_until="domcontentloaded")
            page.get_by_text(args.fixture_title, exact=True).first.wait_for(state="visible")
            open_and_verify_fixture(page, base_url, *fixture_args)

        screenshot = Path(args.screenshot)
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot), full_page=True)
        unexpected = [item for item in failed_responses if "/api/conversations/not-owned/" not in item]
        assert not unexpected, f"unexpected failed responses: {unexpected}"
        assert not console_errors, f"browser console errors: {console_errors}"
        browser.close()

    print(f"spatial-ui-smoke passed phase={args.phase} screenshot={args.screenshot}")


if __name__ == "__main__":
    main()
