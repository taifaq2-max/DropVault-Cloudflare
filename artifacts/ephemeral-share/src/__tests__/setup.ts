import "@testing-library/jest-dom";
import { vi } from "vitest";

Object.defineProperty(window, "location", {
  value: {
    origin: "http://localhost",
    href: "http://localhost/share/test-share-id#key=dGVzdC1rZXktMTIz",
    hash: "#key=dGVzdC1rZXktMTIz",
    pathname: "/share/test-share-id",
  },
  writable: true,
});

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
});
