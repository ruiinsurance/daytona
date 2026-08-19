//go:build linux

// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"fmt"

	"github.com/vishvananda/netlink"
)

func (d *DockerClient) clearBridgePortIsolation(ctx context.Context, bridgeName string) error {
	bridge, err := netlink.LinkByName(bridgeName)
	if err != nil {
		return fmt.Errorf("look up bridge %s: %w", bridgeName, err)
	}
	links, err := netlink.LinkList()
	if err != nil {
		return fmt.Errorf("list links: %w", err)
	}
	bridgeIdx := bridge.Attrs().Index
	for _, link := range links {
		attrs := link.Attrs()
		if attrs.MasterIndex != bridgeIdx {
			continue
		}
		if err := netlink.LinkSetIsolated(link, false); err != nil {
			d.logger.WarnContext(ctx, "Failed to clear isolation on bridge port",
				"bridge", bridgeName, "port", attrs.Name, "error", err)
			continue
		}
	}
	return nil
}
