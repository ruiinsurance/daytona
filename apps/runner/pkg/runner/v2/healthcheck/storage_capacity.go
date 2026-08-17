/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package healthcheck

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/shirou/gopsutil/v4/disk"
	"golang.org/x/sys/unix"
)

func collectStorageNodeCapacity(ctx context.Context, root string) (storageNodeCapacity, error) {
	if root == "" || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return storageNodeCapacity{}, fmt.Errorf("local storage root is invalid")
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return storageNodeCapacity{}, fmt.Errorf("local storage root unavailable")
	}
	usage, err := disk.UsageWithContext(ctx, root)
	if err != nil {
		return storageNodeCapacity{}, fmt.Errorf("local storage capacity unavailable")
	}
	var stat unix.Statfs_t
	if err := unix.Statfs(root, &stat); err != nil {
		return storageNodeCapacity{}, fmt.Errorf("local storage inode capacity unavailable")
	}
	return storageNodeCapacity{
		CapacityBytes:  usage.Total,
		UsedBytes:      usage.Used,
		CapacityInodes: stat.Files,
		UsedInodes:     stat.Files - stat.Ffree,
	}, nil
}
