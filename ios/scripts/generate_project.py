#!/usr/bin/env python3
"""Generate a dependency-free, reproducible Xcode project from the checked-in sources."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
objects = {}


def uid(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24].upper()


def obj(key, isa, **values):
    identifier = uid(key)
    objects[identifier] = {"isa": isa, **values}
    return identifier


def ref(path, kind):
    return obj("file:" + path, "PBXFileReference", lastKnownFileType=kind, path=path, sourceTree="SOURCE_ROOT")


def config_list(name, settings):
    configs = []
    for mode in ["Debug", "Release"]:
        specific = dict(settings)
        specific.update({"SWIFT_OPTIMIZATION_LEVEL": "-Onone" if mode == "Debug" else "-O",
                         "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG" if mode == "Debug" else "",
                         "DEBUG_INFORMATION_FORMAT": "dwarf" if mode == "Debug" else "dwarf-with-dsym"})
        configs.append(obj(name + mode, "XCBuildConfiguration", buildSettings=specific, name=mode))
    return obj(name + "configs", "XCConfigurationList", buildConfigurations=configs,
               defaultConfigurationIsVisible="0", defaultConfigurationName="Release")


def phase(name, kind, files, **kwargs):
    builds = [obj(name + ":" + f, "PBXBuildFile", fileRef=f) for f in files]
    return obj(name, kind, buildActionMask="2147483647", files=builds, runOnlyForDeploymentPostprocessing="0", **kwargs)


common = {"IPHONEOS_DEPLOYMENT_TARGET": "17.0", "SDKROOT": "iphoneos", "SWIFT_VERSION": "5.0",
          "TARGETED_DEVICE_FAMILY": "1,2", "CODE_SIGN_STYLE": "Automatic",
          "CLANG_ENABLE_MODULES": "YES", "SWIFT_STRICT_CONCURRENCY": "complete",
          "ENABLE_USER_SCRIPT_SANDBOXING": "YES", "SUPPORTS_MACCATALYST": "NO"}
app_sources = [ref(str(p.relative_to(ROOT)), "sourcecode.swift") for p in sorted((ROOT / "SecondHand").rglob("*.swift"))]
shared = [ref("SecondHand/Core/" + name, "sourcecode.swift") for name in ["Models.swift", "SecureVault.swift"]]
extension_sources = shared + [ref(str(p.relative_to(ROOT)), "sourcecode.swift") for p in sorted((ROOT / "SafariExtension").glob("*.swift"))]
test_sources = [ref(str(p.relative_to(ROOT)), "sourcecode.swift") for p in sorted((ROOT / "Tests").glob("*Tests.swift")) if "UI" not in p.name]
ui_sources = [ref(str(p.relative_to(ROOT)), "sourcecode.swift") for p in sorted((ROOT / "Tests").glob("*UITests.swift"))]
assets = ref("SecondHand/Assets.xcassets", "folder.assetcatalog")
extension_resources = []
for p in sorted((ROOT / "SafariExtension/Resources").iterdir()):
    kind = "folder" if p.is_dir() else "image.png" if p.suffix == ".png" else "text"
    extension_resources.append(ref(str(p.relative_to(ROOT)), kind))
# Bundle the same verified navigation adapter as the laptop extension, without
# maintaining a second copy of Iowa's conditional-required-question rules.
extension_resources.append(ref("../extension/iowa-adapter.js", "sourcecode.javascript"))

# The offline QA view is compiled only for Debug Simulator and is opt-in.
# Bundle production engines directly so its local replay cannot drift to a mock mapper.
qa_resources = [ref("QAResources/iowa-personal-information.html", "text.html")]
qa_resources += [ref("SafariExtension/Resources/" + name, "sourcecode.javascript") for name in
                 ["field-mapper.js", "application-assistant.js"]]
qa_resources += [ref("../extension/" + name, "sourcecode.javascript") for name in
                 ["iowa-adapter.js", "address-policy.js"]]

profile_import_resources = [ref("../shared/snap-information.js", "sourcecode.javascript")] + [ref("../shared/" + name + ".cjs", "sourcecode.javascript") for name in
                            ["household", "schema", "facts", "document-layout", "document-w2", "document-ssa1099", "document-1099nec", "document-parser"]]

products = {}
for name, ext, kind in [("SecondHand", "app", "wrapper.application"), ("SafariExtension", "appex", "wrapper.app-extension"),
                         ("SecondHandTests", "xctest", "wrapper.cfbundle"), ("SecondHandUITests", "xctest", "wrapper.cfbundle")]:
    products[name] = obj(name + "product", "PBXFileReference", explicitFileType=kind, includeInIndex="0", path=name + "." + ext, sourceTree="BUILT_PRODUCTS_DIR")

app_id = uid("target:SecondHand")
extension_id = uid("target:SafariExtension")
embed_build = obj("embedExtensionBuild", "PBXBuildFile", fileRef=products["SafariExtension"], settings={"ATTRIBUTES": ["RemoveHeadersOnCopy"]})
embed = obj("embedExtensions", "PBXCopyFilesBuildPhase", buildActionMask="2147483647", dstPath="", dstSubfolderSpec="13", files=[embed_build], name="Embed App Extensions", runOnlyForDeploymentPostprocessing="0")


def dependency(name, target):
    proxy = obj(name + "proxy", "PBXContainerItemProxy", containerPortal=uid("project"), proxyType="1", remoteGlobalIDString=target, remoteInfo=name)
    return obj(name + "dependency", "PBXTargetDependency", target=target, targetProxy=proxy)


ext_dep = dependency("SafariExtension", extension_id)
app_dep = dependency("SecondHand", app_id)


def target(name, sources, resources, settings, product_type, deps=None, extra_phases=None):
    obj("target:" + name, "PBXNativeTarget", buildConfigurationList=config_list(name, {**common, **settings}),
        buildPhases=[phase(name + "Sources", "PBXSourcesBuildPhase", sources),
                     phase(name + "Frameworks", "PBXFrameworksBuildPhase", []),
                     phase(name + "Resources", "PBXResourcesBuildPhase", resources)] + (extra_phases or []),
        buildRules=[], dependencies=deps or [], name=name, productName=name,
        productReference=products[name], productType=product_type)


target("SafariExtension", extension_sources, extension_resources,
       {"PRODUCT_BUNDLE_IDENTIFIER": "com.ethanpam.secondhand.SafariExtension", "PRODUCT_NAME": "$(TARGET_NAME)",
        "INFOPLIST_FILE": "SafariExtension/Info.plist", "CODE_SIGN_ENTITLEMENTS": "SafariExtension/SafariExtension.entitlements",
        "APPLICATION_EXTENSION_API_ONLY": "YES", "SKIP_INSTALL": "YES",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"]}, "com.apple.product-type.app-extension")
target("SecondHand", app_sources, [assets] + qa_resources + profile_import_resources,
       {"PRODUCT_BUNDLE_IDENTIFIER": "com.ethanpam.secondhand", "PRODUCT_NAME": "$(TARGET_NAME)",
        "INFOPLIST_FILE": "SecondHand/Info.plist", "CODE_SIGN_ENTITLEMENTS": "SecondHand/SecondHand.entitlements",
        "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon", "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME": "AccentColor",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"]},
       "com.apple.product-type.application", [ext_dep], [embed])
test_resources = [ref(str(p.relative_to(ROOT)), "image.pdf") for p in sorted((ROOT / "Tests/Fixtures").glob("*.pdf"))]
target("SecondHandTests", test_sources, test_resources,
       {"PRODUCT_BUNDLE_IDENTIFIER": "com.ethanpam.secondhand.tests", "PRODUCT_NAME": "$(TARGET_NAME)", "GENERATE_INFOPLIST_FILE": "YES",
        "TEST_HOST": "$(BUILT_PRODUCTS_DIR)/SecondHand.app/SecondHand", "BUNDLE_LOADER": "$(TEST_HOST)",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks"]},
       "com.apple.product-type.bundle.unit-test", [app_dep])
target("SecondHandUITests", ui_sources, [],
       {"PRODUCT_BUNDLE_IDENTIFIER": "com.ethanpam.secondhand.uitests", "PRODUCT_NAME": "$(TARGET_NAME)", "GENERATE_INFOPLIST_FILE": "YES",
        "TEST_TARGET_NAME": "SecondHand", "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks"]},
       "com.apple.product-type.bundle.ui-testing", [app_dep])
product_group = obj("products", "PBXGroup", children=list(products.values()), name="Products", sourceTree="<group>")
all_files = list(dict.fromkeys(app_sources + extension_sources + test_sources + test_resources + ui_sources + [assets] + extension_resources + qa_resources + profile_import_resources))
main_group = obj("main", "PBXGroup", children=all_files + [product_group], sourceTree="<group>")
obj("project", "PBXProject", attributes={"BuildIndependentTargetsInParallel": "YES", "LastUpgradeCheck": "2600"},
    buildConfigurationList=config_list("project", {"ENABLE_TESTABILITY": "YES", "CLANG_WARN_DOCUMENTATION_COMMENTS": "YES"}),
    compatibilityVersion="Xcode 14.0", developmentRegion="en", hasScannedForEncodings="0", knownRegions=["en", "Base"],
    mainGroup=main_group, productRefGroup=product_group, projectDirPath="", projectRoot="",
    targets=[uid("target:" + n) for n in products])


def serialize(value, indent=0):
    if isinstance(value, dict):
        return "{\n" + "".join("\t" * (indent + 1) + json.dumps(k) + " = " + serialize(v, indent + 1) + ";\n" for k, v in value.items()) + "\t" * indent + "}"
    if isinstance(value, list):
        return "(" + ", ".join(serialize(v, indent) for v in value) + ")"
    return json.dumps(str(value))


project = ROOT / "SecondHand.xcodeproj"
project.mkdir(exist_ok=True)
(project / "project.pbxproj").write_text("// !$*UTF8*$!\n" + serialize({"archiveVersion": "1", "classes": {}, "objectVersion": "56", "objects": objects, "rootObject": uid("project")}) + "\n")
scheme_dir = project / "xcshareddata/xcschemes"
scheme_dir.mkdir(parents=True, exist_ok=True)


def build_ref(name):
    suffix = "app" if name == "SecondHand" else "xctest"
    return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid("target:" + name)}" BuildableName="{name}.{suffix}" BlueprintName="{name}" ReferencedContainer="container:SecondHand.xcodeproj"/>'


(scheme_dir / "SecondHand.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{build_ref("SecondHand")}</BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>
    <TestableReference skipped="NO">{build_ref("SecondHandTests")}</TestableReference>
    <TestableReference skipped="NO">{build_ref("SecondHandUITests")}</TestableReference>
  </Testables></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{build_ref("SecondHand")}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{build_ref("SecondHand")}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
print("Generated SecondHand.xcodeproj")
