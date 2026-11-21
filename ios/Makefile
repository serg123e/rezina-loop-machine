# Rezina (iOS). `make help` lists the targets. Build and release: CLAUDE.md in this folder.

IOS_RUNNER ?= macos-15
BRANCH ?= $(shell git branch --show-current)
SWIFTLY = . $(HOME)/.local/share/swiftly/env.sh

.DEFAULT_GOAL := help
.PHONY: help build install icon ci testflight release

help: ## list targets
	@grep -E '^[a-z][a-z0-9-]*:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

build: ## compile check on Linux (xtool) → xtool/Rezina.app
	bash -c '$(SWIFTLY) && xtool dev build'

install: ## build + sign + install on an iPhone over USB (xtool)
	bash -c '$(SWIFTLY) && xtool dev'

icon: ## render the app icon from ../store/icon.svg (middle 72×72 of the 108 canvas, as Android shows it; no alpha)
	sed 's/viewBox="0 0 108 108"/viewBox="18 18 72 72"/' ../store/icon.svg | rsvg-convert -w 1024 -h 1024 | \
	magick - -background '#14141C' -alpha remove -alpha off PNG24:Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png

ci: ## unsigned macOS build on GitHub of the pushed branch (no upload)
	gh workflow run ios.yml --ref $(BRANCH) -f runner=$(IOS_RUNNER) && sleep 8 && \
	gh run watch $$(gh run list --workflow ios.yml -L1 --json databaseId -q '.[0].databaseId') --exit-status

testflight: ## build + upload to TestFlight from the pushed branch, no tag or notes
	gh workflow run ios.yml --ref $(BRANCH) -f runner=$(IOS_RUNNER) -f upload=true && sleep 8 && \
	gh run watch $$(gh run list --workflow ios.yml -L1 --json databaseId -q '.[0].databaseId') --exit-status

release: ## TestFlight RELEASE: checks → build → "What to Test" → testers → tag ios-v<version>. DRY=1 — checks only
	DRY=$(DRY) IOS_RUNNER=$(IOS_RUNNER) bin/release
