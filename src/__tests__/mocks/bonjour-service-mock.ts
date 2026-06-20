// Lightweight mock for bonjour-service so Jest can test agent-registry.ts
// without real mDNS traffic.  Follows the same pattern as chokidar-mock.ts.

import { jest } from '@jest/globals';

export const mockPublish = jest.fn<any>().mockReturnValue({ stop: jest.fn() });
export const mockUnpublishAll = jest.fn();
export const mockDestroy = jest.fn();
export const mockBrowserOn = jest.fn();
export const mockBrowserStop = jest.fn();
export const mockFind = jest.fn<any>().mockReturnValue({
  on: mockBrowserOn,
  stop: mockBrowserStop,
});

function createInstance() {
  return {
    publish: mockPublish,
    unpublishAll: mockUnpublishAll,
    destroy: mockDestroy,
    find: mockFind,
  };
}

// Named export matches `import { Bonjour } from 'bonjour-service'`
const Bonjour = jest.fn<any>().mockImplementation(createInstance);
export default Bonjour;
export { Bonjour };

/** Reset all mock state between tests. */
export function resetMocks(): void {
  mockPublish.mockClear().mockReturnValue({ stop: jest.fn() });
  mockUnpublishAll.mockClear();
  mockDestroy.mockClear();
  mockBrowserOn.mockClear();
  mockBrowserStop.mockClear();
  mockFind.mockClear().mockReturnValue({ on: mockBrowserOn, stop: mockBrowserStop });
  Bonjour.mockClear();
}
