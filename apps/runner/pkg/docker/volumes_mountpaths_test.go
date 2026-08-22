// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"os"
	"path/filepath"
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

func TestLocalVolumeBindsUseCanonicalSameSourceWithoutMountS3(t *testing.T) {
	root := t.TempDir()
	client := newStartTestDockerClient(nil)
	client.localVolumeRoot = root
	sandboxID := "11111111-1111-4111-8111-111111111111"
	subpath := "sandboxes/" + sandboxID + "/workspace"
	volumes := []dto.VolumeDTO{
		{VolumeId: testVolumeID, MountPath: "/workspace", Subpath: &subpath, Backend: localVolumeBackend},
		{VolumeId: testVolumeID, MountPath: "/config", Subpath: &subpath, Backend: localVolumeBackend},
	}

	binDir := t.TempDir()
	writeFakeCommand(t, binDir, "mount-s3", "echo mount-s3-must-not-run >&2; exit 97")
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	binds, err := client.getVolumesMountPathBinds(context.Background(), volumes)
	if err != nil {
		t.Fatalf("getVolumesMountPathBinds() error = %v", err)
	}
	wantSource := filepath.Join(root, volumeMountPrefix+testVolumeID, filepath.FromSlash(subpath))
	want := []string{wantSource + "/:/workspace/", wantSource + "/:/config/"}
	if !reflect.DeepEqual(binds, want) {
		t.Fatalf("local binds = %#v, want %#v", binds, want)
	}
	info, err := os.Stat(wantSource)
	if err != nil || !info.IsDir() {
		t.Fatalf("local source was not created as a directory: info=%v err=%v", info, err)
	}
	if info.Mode().Perm() != 0o777 {
		t.Fatalf("local workspace mode = %v; want 0777", info.Mode().Perm())
	}
}

func TestValidateLocalWorkspaceSubpathRejectsNonCanonicalPaths(t *testing.T) {
	tests := []string{
		"../sandboxes/11111111-1111-4111-8111-111111111111/workspace",
		"/sandboxes/11111111-1111-4111-8111-111111111111/workspace",
		"sandboxes/11111111-1111-4111-8111-111111111111/../workspace",
		"sandboxes/11111111-1111-4111-8111-111111111111/config",
		"sandboxes/11111111-1111-1111-8111-111111111111/workspace",
		"sandboxes/11111111-1111-4111-8111-11111111111A/workspace",
	}

	for _, subpath := range tests {
		t.Run(subpath, func(t *testing.T) {
			if err := validateLocalWorkspaceSubpath(&subpath); err == nil {
				t.Fatalf("validateLocalWorkspaceSubpath(%q) succeeded, want rejection", subpath)
			}
		})
	}
}

func TestLocalVolumeBackendRequiresNoEnableSwitch(t *testing.T) {
	root := t.TempDir()
	client := newStartTestDockerClient(nil)
	client.localVolumeRoot = root
	subpath := "sandboxes/11111111-1111-4111-8111-111111111111/workspace"
	binds, err := client.getVolumesMountPathBinds(context.Background(), []dto.VolumeDTO{
		{VolumeId: testVolumeID, MountPath: "/workspace", Subpath: &subpath, Backend: localVolumeBackend},
		{VolumeId: testVolumeID, MountPath: "/config", Subpath: &subpath, Backend: localVolumeBackend},
	})
	if err != nil {
		t.Fatalf("getVolumesMountPathBinds() error = %v", err)
	}
	if len(binds) != 2 {
		t.Fatalf("getVolumesMountPathBinds() = %#v, want workspace and config binds", binds)
	}
}

func TestLocalVolumeBindsRejectSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	volumeDir := filepath.Join(root, volumeMountPrefix+testVolumeID)
	if err := os.Mkdir(volumeDir, 0o750); err != nil {
		t.Fatalf("create volume directory: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(volumeDir, "sandboxes")); err != nil {
		t.Fatalf("create escaping symlink: %v", err)
	}
	client := newStartTestDockerClient(nil)
	client.localVolumeRoot = root
	subpath := "sandboxes/11111111-1111-4111-8111-111111111111/workspace"
	_, err := client.getVolumesMountPathBinds(context.Background(), []dto.VolumeDTO{
		{VolumeId: testVolumeID, MountPath: "/workspace", Subpath: &subpath, Backend: localVolumeBackend},
		{VolumeId: testVolumeID, MountPath: "/config", Subpath: &subpath, Backend: localVolumeBackend},
	})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("getVolumesMountPathBinds() error = %v, want symlink rejection", err)
	}
}

func TestValidateLocalVolumeRootRejectsSymlinkBeforeCreatingChildren(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(base, "linked-root")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("create root symlink: %v", err)
	}

	_, err := validateLocalVolumeRoot(filepath.Join(link, "must-not-be-created"))
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("validateLocalVolumeRoot() error = %v, want symlink rejection", err)
	}
	if _, statErr := os.Stat(filepath.Join(outside, "must-not-be-created")); !os.IsNotExist(statErr) {
		t.Fatalf("root validation wrote through symlink: %v", statErr)
	}
}

func TestValidateLocalVolumeRootRejectsMissingRoot(t *testing.T) {
	missingRoot := filepath.Join(t.TempDir(), "missing-root")

	_, err := validateLocalVolumeRoot(missingRoot)
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("validateLocalVolumeRoot() error = %v, want missing-root rejection", err)
	}
	if _, statErr := os.Stat(missingRoot); !os.IsNotExist(statErr) {
		t.Fatalf("root validation created an unmounted directory: %v", statErr)
	}
}

func TestLocalVolumeBindsRejectMismatchedWorkspaceAndConfig(t *testing.T) {
	root := t.TempDir()
	client := newStartTestDockerClient(nil)
	client.localVolumeRoot = root
	workspace := "sandboxes/11111111-1111-4111-8111-111111111111/workspace"
	config := "sandboxes/22222222-2222-4222-8222-222222222222/workspace"
	_, err := client.getVolumesMountPathBinds(context.Background(), []dto.VolumeDTO{
		{VolumeId: testVolumeID, MountPath: "/workspace", Subpath: &workspace, Backend: localVolumeBackend},
		{VolumeId: testVolumeID, MountPath: "/config", Subpath: &config, Backend: localVolumeBackend},
	})
	if err == nil || !strings.Contains(err.Error(), "same local source") {
		t.Fatalf("getVolumesMountPathBinds() error = %v, want same-source rejection", err)
	}
}

func TestLocalVolumeBindsRejectMixedCOSVolumes(t *testing.T) {
	root := t.TempDir()
	client := newStartTestDockerClient(nil)
	client.localVolumeRoot = root
	subpath := "sandboxes/11111111-1111-4111-8111-111111111111/workspace"
	_, err := client.getVolumesMountPathBinds(context.Background(), []dto.VolumeDTO{
		{VolumeId: testVolumeID, MountPath: "/workspace", Subpath: &subpath, Backend: localVolumeBackend},
		{VolumeId: testVolumeID, MountPath: "/config", Subpath: &subpath, Backend: localVolumeBackend},
		{VolumeId: "22222222-2222-4222-8222-222222222222", MountPath: "/data"},
	})
	if err == nil || !strings.Contains(err.Error(), "cannot be mixed with COS volumes") {
		t.Fatalf("getVolumesMountPathBinds() error = %v, want mixed-backend rejection", err)
	}
}

func TestRunnerRejectsNonLocalVolumesBeforeMountS3(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "mount-s3-ran")
	binDir := t.TempDir()
	writeFakeCommand(t, binDir, "mount-s3", "touch "+marker+"; exit 97")
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := newStartTestDockerClient(nil)
	_, err := client.getVolumesMountPathBinds(context.Background(), []dto.VolumeDTO{
		{VolumeId: testVolumeID, MountPath: "/workspace", Backend: "cos"},
	})
	if err == nil || !strings.Contains(err.Error(), "runner only supports local volumes") {
		t.Fatalf("getVolumesMountPathBinds() error = %v, want local-only rejection", err)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Fatalf("mount-s3 was executed before local-only rejection: %v", statErr)
	}
}
