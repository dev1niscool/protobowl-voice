"""Build an identity-free, ad-hoc-signed macOS Safari app with Xcode.

Run scripts/package.py first to prepare dist/safari-extension. Generated Xcode
files and build logs stay under ignored dist/ and are never included in releases.
"""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
import json
import plistlib
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
RESOURCES = DIST / "safari-extension"
BUILD = DIST / "safari-build"
APP_NAME = "ProtoBowl Voice"
BUNDLE_ID = "org.protobowl.voice"
NATIVE = ROOT / "safari" / "native"


def run(arguments, log_name):
    """Keep compiler paths and incidental local metadata out of console output."""
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (BUILD / log_name).write_bytes(result.stdout)
    if result.returncode:
        raise SystemExit(f"Safari build failed; inspect dist/safari-build/{log_name} locally.")


def make_zip(app, version):
    output = DIST / f"protobowl-voice-safari-macos-{version}.zip"
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(app.rglob("*")):
            if path.is_symlink():
                raise SystemExit("Unexpected symbolic link in app bundle.")
            if not path.is_file():
                continue
            relative = path.relative_to(app.parent).as_posix()
            if any(part.startswith(".") for part in path.relative_to(app).parts):
                raise SystemExit("Unexpected hidden file in app bundle.")
            entry = ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            # Preserve executable bits without storing host ownership or dates.
            entry.create_system = 3
            executable = path.parent.name == "MacOS"
            entry.external_attr = (0o100755 if executable else 0o100644) << 16
            entry.compress_type = ZIP_DEFLATED
            archive.writestr(entry, path.read_bytes(), compresslevel=9)
    print(output.relative_to(ROOT))


def main():
    if sys.platform != "darwin":
        raise SystemExit("The Safari macOS app build requires macOS and Xcode.")
    if not (RESOURCES / "manifest.json").is_file():
        raise SystemExit("Run python3 scripts/package.py first.")
    manifest = json.loads((RESOURCES / "manifest.json").read_text())
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Expected a three-part numeric extension version.")
    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True)
    run([
        "xcrun", "safari-web-extension-converter", str(RESOURCES),
        "--project-location", str(BUILD / "project"), "--app-name", APP_NAME,
        "--bundle-identifier", BUNDLE_ID, "--objc", "--macos-only",
        "--copy-resources", "--no-open", "--no-prompt",
    ], "converter.log")

    project_root = BUILD / "project" / APP_NAME
    project = project_root / f"{APP_NAME}.xcodeproj"
    app_source = project_root / APP_NAME
    extension_source = project_root / f"{APP_NAME} Extension"
    # Xcode generates personal author/date headers. Replace them even though
    # generated project files are private build intermediates, never releases.
    for path in project_root.rglob("*"):
        if path.suffix in {".m", ".h"}:
            source = path.read_text()
            source = re.sub(r"\A(?://[^\n]*\n)+", "// ProtoBowl Voice\n", source)
            path.write_text(source)
    resource_sources = {
        "ViewController.m": app_source / "ViewController.m",
        "Main.html": app_source / "Resources" / "Base.lproj" / "Main.html",
        "Style.css": app_source / "Resources" / "Style.css",
        "Script.js": app_source / "Resources" / "Script.js",
    }
    for name, destination in resource_sources.items():
        if not destination.is_file():
            raise SystemExit("The Xcode converter's native resource layout changed.")
        shutil.copyfile(NATIVE / name, destination)
    shutil.copyfile(NATIVE / "SafariWebExtensionHandler.m", extension_source / "SafariWebExtensionHandler.m")
    storyboard = app_source / "Base.lproj" / "Main.storyboard"
    source = storyboard.read_text().replace('width="425" height="325"', 'width="560" height="640"')
    source = source.replace('titled="YES" closable="YES"', 'titled="YES" closable="YES" resizable="YES"')
    storyboard.write_text(source)

    settings = project / "project.pbxproj"
    source = settings.read_text()
    # Normalize the containing app ID as some converter versions derive it from
    # the display name rather than using the requested identifier verbatim.
    source = re.sub(
        r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);",
        lambda match: "PRODUCT_BUNDLE_IDENTIFIER = " + BUNDLE_ID +
        (".Extension" if ".Extension" in match.group(1) else "") + ";",
        source,
    )
    source = re.sub(r"DEVELOPMENT_TEAM = [^;]*;", 'DEVELOPMENT_TEAM = "";', source)
    source = re.sub(r"CODE_SIGN_STYLE = [^;]*;", "CODE_SIGN_STYLE = Manual;", source)
    settings.write_text(source)
    for folder in project.rglob("xcuserdata"):
        shutil.rmtree(folder)

    run([
        "xcodebuild", "-project", str(project), "-scheme", APP_NAME,
        "-configuration", "Release", "-derivedDataPath", str(BUILD / "derived"),
        "ARCHS=arm64 x86_64", "ONLY_ACTIVE_ARCH=NO", "MACOSX_DEPLOYMENT_TARGET=13.0",
        "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "DEVELOPMENT_TEAM=",
        "CODE_SIGN_IDENTITY=", "PROVISIONING_PROFILE_SPECIFIER=",
        "GCC_GENERATE_DEBUGGING_SYMBOLS=NO", "CLANG_ENABLE_MODULE_DEBUGGING=NO",
        "DEBUG_INFORMATION_FORMAT=dwarf", "COPY_PHASE_STRIP=YES",
        "STRIP_INSTALLED_PRODUCT=YES", "DEPLOYMENT_POSTPROCESSING=YES",
        "OTHER_LDFLAGS=-Wl,-no_uuid", "ENABLE_APP_INTENTS_METADATA_EXTRACTION=NO",
        f"MARKETING_VERSION={version}", "CURRENT_PROJECT_VERSION=1", "build",
    ], "xcodebuild.log")

    built_app = BUILD / "derived" / "Build" / "Products" / "Release" / f"{APP_NAME}.app"
    release_app = DIST / f"{APP_NAME}.app"
    if release_app.exists():
        shutil.rmtree(release_app)
    shutil.copytree(built_app, release_app, copy_function=shutil.copyfile)
    bundled_resources = release_app / "Contents" / "Resources"
    for name, relative in [("Main.html", "Base.lproj/Main.html"),
                           ("Style.css", "Style.css"), ("Script.js", "Script.js")]:
        if (bundled_resources / relative).read_bytes() != (NATIVE / name).read_bytes():
            raise SystemExit(f"The native app did not bundle the expected {name}.")
    for path in release_app.rglob("*"):
        if path.is_file():
            path.chmod(0o755 if path.parent.name == "MacOS" else 0o644)
        if path.name == "Info.plist":
            info = plistlib.loads(path.read_bytes())
            # These describe the build environment, not runtime requirements.
            info = {key: value for key, value in info.items()
                    if key != "BuildMachineOSBuild" and not key.startswith("DT")}
            path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY, sort_keys=True))
    extension = release_app / "Contents" / "PlugIns" / f"{APP_NAME} Extension.appex"
    for label, bundle in [("extension", extension), ("app", release_app)]:
        entitlements = BUILD / f"{label}-entitlements.plist"
        capabilities = {"com.apple.security.app-sandbox": True}
        if label == "app":
            # Preserve the template's capability for WKWebView's network process.
            # The containing app loads only its bundled setup page.
            capabilities["com.apple.security.network.client"] = True
        entitlements.write_bytes(plistlib.dumps(capabilities))
        run(["codesign", "--force", "--sign", "-", "--timestamp=none",
             "--entitlements", str(entitlements), str(bundle)], f"sign-{label}.log")
    run(["codesign", "--verify", "--deep", "--strict", str(release_app)], "verify.log")
    make_zip(release_app, version)


if __name__ == "__main__":
    main()
