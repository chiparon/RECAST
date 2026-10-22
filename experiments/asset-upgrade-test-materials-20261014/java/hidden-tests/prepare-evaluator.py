"""Preserve the target's build/dependencies while injecting private host tests."""
from pathlib import Path
import shutil
import sys
import xml.etree.ElementTree as ET

target, root = (Path(path).resolve() for path in sys.argv[1:])
evaluation_project = root / "target-project"
shutil.copytree(target, evaluation_project, ignore=shutil.ignore_patterns("target", ".git", "node_modules"))
namespace = "http://maven.apache.org/POM/4.0.0"
ET.register_namespace("", namespace)
ET.register_namespace("xsi", "http://www.w3.org/2001/XMLSchema-instance")


def tag(name):
    return "{" + namespace + "}" + name


def child(parent, name):
    existing = parent.find(tag(name))
    return existing if existing is not None else ET.SubElement(parent, tag(name))


tree = ET.parse(evaluation_project / "pom.xml")
project = tree.getroot()
dependencies = child(project, "dependencies")
for group, artifact, version in [
    ("org.junit.jupiter", "junit-jupiter", "5.11.3"),
    ("com.h2database", "h2", "2.3.232"),
]:
    existing = next((dep for dep in dependencies
                     if dep.findtext(tag("groupId")) == group
                     and dep.findtext(tag("artifactId")) == artifact), None)
    if existing is None:
        dep = ET.SubElement(dependencies, tag("dependency"))
        for name, value in {"groupId": group, "artifactId": artifact, "version": version, "scope": "test"}.items():
            child(dep, name).text = value
    # Existing production dependencies (including H2) keep their scope/version.

build = child(project, "build")
child(build, "testSourceDirectory").text = str(root / "src/test/java")
plugins = child(build, "plugins")
surefire = next((plugin for plugin in plugins
                 if plugin.findtext(tag("artifactId")) == "maven-surefire-plugin"), None)
if surefire is None:
    surefire = ET.SubElement(plugins, tag("plugin"))
    child(surefire, "groupId").text = "org.apache.maven.plugins"
    child(surefire, "artifactId").text = "maven-surefire-plugin"
child(surefire, "version").text = "3.5.2"
configuration = child(surefire, "configuration")
child(configuration, "useModulePath").text = "false"
child(configuration, "reportsDirectory").text = str(evaluation_project / "target/surefire-reports")
child(configuration, "skipTests").text = "false"
child(configuration, "skip").text = "false"
child(configuration, "testFailureIgnore").text = "false"

ET.indent(tree, space="  ")
tree.write(evaluation_project / "pom.xml", encoding="UTF-8", xml_declaration=True)
