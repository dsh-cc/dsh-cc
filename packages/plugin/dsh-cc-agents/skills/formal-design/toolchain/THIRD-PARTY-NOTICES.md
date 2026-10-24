# Bundled TLC toolchain

This directory redistributes the unmodified official TLA+ Tools v1.7.4
`tla2tools.jar` (2,274,532 bytes). It is a third-party artifact, not code
licensed solely under this plugin's Apache-2.0 package metadata.

- Release: https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4
- Binary: https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
- Exact upstream source revision: 5a47802b5c391f59ecdd44117981f4ff8c0656ba
- Source: https://github.com/tlaplus/tlaplus/tree/5a47802b5c391f59ecdd44117981f4ff8c0656ba
- SHA-1: bee4a54f3ee3d4afc347c3240ec2d9e93b075104
- SHA-256: 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

## TLA+ Tools

The original MIT copyright/license notice from the JAR's `License.txt` is
reproduced verbatim in `LICENSE`. All original entries and notices remain
inside the unmodified JAR.

## Embedded JavaMail 1.6.3

The upstream TLA+ build includes `mailapi-1.6.3.jar` and `smtp-1.6.3.jar`.
The original Eclipse Public License 2.0 text from `META-INF/LICENSE.txt` in
the distributed TLC JAR is reproduced in `licenses/JAVAMAIL-EPL-2.0.txt`.
JavaMail source code is available under the upstream license at:

https://github.com/eclipse-ee4j/javamail/tree/7be4f44afd920e35ede59aa06221cedc7b9bd12c

This is the source revision for the upstream `1.6.3` tag. The EPL text,
including its secondary-license provisions, is retained without modification.

## Embedded JavaBeans Activation implementation

TLA+ v1.7.4's build uses the Eclipse Orbit bundle
`javax.activation_1.1.0.v201211130549.jar`. Its manifest identifies the
implementation vendor as Geronimo. The build copies its `javax.activation`
classes into TLC (and excludes the bundle's `org/**` classes).

The following original files from that exact dependency are preserved:

- `licenses/ACTIVATION-APACHE-2.0.txt`: `META-INF/LICENSE.txt`.
- `licenses/ACTIVATION-NOTICE.txt`: `META-INF/NOTICE.txt`.
- `licenses/ACTIVATION-ABOUT.html`: `about.html`.
- `licenses/ACTIVATION-ABOUT-NOTICE.txt`: `about_files/NOTICE.txt`.

The Apache license also occurs as `about_files/LICENSE.txt` in the bundle;
its text is identical to the reproduced `META-INF/LICENSE.txt`.
The unmodified dependency and the build instructions are available in the
pinned TLA+ source tree's `tlatools/org.lamport.tlatools/lib/javax.mail/` and
`customBuild.xml`, respectively. The retained about file records upstream
attribution and source details.

No third-party source or binary was modified. The runner still validates the
pinned checksum before checking any model. Toolchain updates must update this
provenance, preserve applicable notices, and re-run the parser/model/packaging
acceptance tests. No runtime or postinstall download is used.
