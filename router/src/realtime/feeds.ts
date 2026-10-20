// Subway GTFS-realtime feeds. GET works without a key; HEAD answers 403.

// tripID: the static trip_id. subwayTripID: origin time, route, and direction from MTA subway trip ids.
export type TripMatch = "tripID" | "subwayTripID";

export type FeedContent =
  | { kind: "tripUpdates"; namespace: string; match: TripMatch }
  // `agencies` maps an entity's agency_id to a stop namespace; "" stands for entities without one.
  | { kind: "alerts"; agencies: Record<string, string> };

export interface RealtimeFeed {
  id: string;
  url: string;
  content: FeedContent;
}

export const MTA_FEEDS = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/";

export const SUBWAY_FEEDS: RealtimeFeed[] = [
  ...["gtfs", "gtfs-ace", "gtfs-bdfm", "gtfs-g", "gtfs-jz", "gtfs-nqrw", "gtfs-l", "gtfs-si"].map(
    (name): RealtimeFeed => ({
      id: `subway-${name}`,
      url: `${MTA_FEEDS}nyct%2F${name}`,
      content: { kind: "tripUpdates", namespace: "subway", match: "subwayTripID" },
    }),
  ),
  {
    id: "mta-alerts",
    url: `${MTA_FEEDS}camsys%2Fall-alerts`,
    content: { kind: "alerts", agencies: { MTASBWY: "subway" } },
  },
];
