// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"reflect"
	"strings"
	"testing"

	"github.com/daytonaio/runner/pkg/api/dto"
)

const testVolumeID = "01932f6e-9df2-7b10-bb66-e198b7c8834a"

func TestGetMountArgsPreservesPerVolumeBucketLayout(t *testing.T) {
	client := &DockerClient{}

	args, err := client.getMountArgs(testVolumeID, "/mnt/daytona-volume-"+testVolumeID)
	if err != nil {
		t.Fatalf("getMountArgs() error = %v", err)
	}

	want := []string{
		"--allow-other",
		"--allow-delete",
		"--allow-overwrite",
		"--file-mode",
		"0666",
		"--dir-mode",
		"0777",
		"daytona-volume-" + testVolumeID,
		"/mnt/daytona-volume-" + testVolumeID,
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("getMountArgs() = %#v, want %#v", args, want)
	}
}

func TestGetMountArgsUsesFixedBucketAndCanonicalPrefix(t *testing.T) {
	client := &DockerClient{
		awsVolumeLayout:  "single-bucket-prefix",
		awsDefaultBucket: "daytona-test-1250000000",
		awsVolumePrefix:  "r3-prod/daytona/volumes",
	}
	mountPath := "/mnt/daytona-volume-" + testVolumeID

	args, err := client.getMountArgs(testVolumeID, mountPath)
	if err != nil {
		t.Fatalf("getMountArgs() error = %v", err)
	}

	want := []string{
		"--allow-other",
		"--allow-delete",
		"--allow-overwrite",
		"--file-mode",
		"0666",
		"--dir-mode",
		"0777",
		"--prefix",
		"r3-prod/daytona/volumes/" + testVolumeID + "/",
		"daytona-test-1250000000",
		mountPath,
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("getMountArgs() = %#v, want %#v", args, want)
	}
}

func TestGetMountArgsRejectsNonCanonicalVolumeIDs(t *testing.T) {
	client := &DockerClient{
		awsVolumeLayout:  singleBucketPrefixLayout,
		awsDefaultBucket: "daytona-test-1250000000",
		awsVolumePrefix:  "r3-prod/daytona/volumes",
	}
	for _, volumeID := range []string{
		"",
		"../" + testVolumeID,
		strings.ToUpper(testVolumeID),
		strings.ReplaceAll(testVolumeID, "-", ""),
	} {
		t.Run(volumeID, func(t *testing.T) {
			if args, err := client.getMountArgs(volumeID, "/mnt/test"); err == nil || args != nil {
				t.Fatalf("getMountArgs(%q) = %#v, %v; want nil args and an error", volumeID, args, err)
			}
		})
	}
}

func TestGetMountArgsRejectsUnsafeSingleBucketConfiguration(t *testing.T) {
	tests := []struct {
		name   string
		layout string
		bucket string
		prefix string
	}{
		{name: "empty bucket", layout: singleBucketPrefixLayout, prefix: "r3-prod/daytona/volumes"},
		{name: "bucket path", layout: singleBucketPrefixLayout, bucket: "shared/bucket", prefix: "r3-prod/daytona/volumes"},
		{name: "empty prefix", layout: singleBucketPrefixLayout, bucket: "shared-bucket"},
		{name: "absolute prefix", layout: singleBucketPrefixLayout, bucket: "shared-bucket", prefix: "/r3-prod/daytona/volumes"},
		{name: "parent segment", layout: singleBucketPrefixLayout, bucket: "shared-bucket", prefix: "r3-prod/../volumes"},
		{name: "current segment", layout: singleBucketPrefixLayout, bucket: "shared-bucket", prefix: "r3-prod/./volumes"},
		{name: "empty segment", layout: singleBucketPrefixLayout, bucket: "shared-bucket", prefix: "r3-prod//volumes"},
		{name: "backslash", layout: singleBucketPrefixLayout, bucket: "shared-bucket", prefix: `r3-prod\volumes`},
		{name: "trailing slash", layout: singleBucketPrefixLayout, bucket: "shared-bucket", prefix: "r3-prod/daytona/volumes/"},
		{name: "unknown layout", layout: "single-bucket-prefx", bucket: "shared-bucket", prefix: "r3-prod/daytona/volumes"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &DockerClient{
				awsVolumeLayout:  tt.layout,
				awsDefaultBucket: tt.bucket,
				awsVolumePrefix:  tt.prefix,
			}
			if args, err := client.getMountArgs(testVolumeID, "/mnt/test"); err == nil || args != nil {
				t.Fatalf("getMountArgs() = %#v, %v; want nil args and an error", args, err)
			}
		})
	}
}

func TestResolveVolumeMountPathsRejectsEscapingSubpaths(t *testing.T) {
	for _, subpath := range []string{"../workspace", "../../outside", "/absolute/workspace"} {
		t.Run(subpath, func(t *testing.T) {
			volume := dto.VolumeDTO{VolumeId: testVolumeID, MountPath: "/workspace", Subpath: &subpath}
			baseMountPath, bindSource, err := resolveVolumeMountPaths(volume)
			if err == nil || baseMountPath != "" || bindSource != "" {
				t.Fatalf("resolveVolumeMountPaths(%q) = %q, %q, %v; want empty paths and an error", subpath, baseMountPath, bindSource, err)
			}
		})
	}
}
