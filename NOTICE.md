# Notice — data and software in this graph

The graph file (`graph.obj`, shipped compressed as `graph.obj.zst`) is a database derived from the sources below. Reuse of the graph
is subject to their licences. This notice travels with every artifact.

## OpenStreetMap
- Source: Geofabrik GmbH extract of OpenStreetMap (see `manifest.json` for the exact file and SHA-256).
- Licence: Open Data Commons Open Database License 1.0 (ODbL 1.0) — https://opendatacommons.org/licenses/odbl/1-0/
- Attribution: © OpenStreetMap contributors — https://www.openstreetmap.org/copyright
- The graph contains OpenStreetMap data and is a derived database: if you publicly use or share it, keep this attribution and offer
  the derived database under the ODbL.

## Public-transport timetable (GTFS)
- Source: Comune di Milano / AMAT — Agenzia Mobilità Ambiente Territorio, dataset DS929, generated from ATM scheduled service —
  https://dati.comune.milano.it/dataset/ds929-orari-del-trasporto-pubblico-locale-nel-comune-di-milano-in-formato-gtfs
- Licence stated by the publisher: Creative Commons Attribution 3.0 Italy (CC BY 3.0 IT) — http://creativecommons.org/licenses/by/3.0/it/legalcode
- Attribution: Comune di Milano / AMAT. The timetable is the scheduled service only (no real-time data) and is valid only for the dates
  in `gtfs-validity-report.json`; the graph must not be relied on outside them.

## Software
- OpenTripPlanner 2.9.0 (GNU LGPL v3) — https://www.opentripplanner.org/ — downloaded from Maven Central and not redistributed here.
- Eclipse Temurin JRE container image, pinned by digest in `versions.json`.

## Warranty
The data and the graph are provided as they are, without warranty of accuracy or completeness.
