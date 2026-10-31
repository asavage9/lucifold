#define _DARWIN_C_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define COLLISION_EXIT 17
#define MAX_COMPONENTS 1024
#define COPY_BUFFER_SIZE 65536

static void report_error(const char *message) {
  fprintf(stderr, "%s\n", message);
}

static int fail_errno(const char *operation) {
  fprintf(stderr, "%s: %s\n", operation, strerror(errno));
  return 1;
}

static int descriptor_path(int descriptor, char *buffer, size_t buffer_size) {
  if (fcntl(descriptor, F_GETPATH, buffer) < 0) return fail_errno("inspect export directory path");
  buffer[buffer_size - 1] = '\0';
  return 0;
}

static bool path_is_within(const char *parent, const char *child) {
  size_t parent_length = strlen(parent);
  if (strcmp(parent, "/") == 0) return child[0] == '/';
  return strcmp(parent, child) == 0 || (strncmp(parent, child, parent_length) == 0 && child[parent_length] == '/');
}

static int validate_directory_containment(int root_fd, int destination_fd, const char *expected_root) {
  char root_path[PATH_MAX];
  char destination_path[PATH_MAX];
  if (descriptor_path(root_fd, root_path, sizeof(root_path)) != 0 || descriptor_path(destination_fd, destination_path, sizeof(destination_path)) != 0) return 1;
  if (strcmp(root_path, expected_root) != 0 || !path_is_within(root_path, destination_path)) {
    report_error("export directory changed outside the authorized destination");
    return 1;
  }
  return 0;
}

static bool valid_component(const char *component) {
  return component[0] != '\0' && strcmp(component, ".") != 0 && strcmp(component, "..") != 0 && strchr(component, '/') == NULL;
}

static int copy_source(int source_fd, int destination_fd) {
  char buffer[COPY_BUFFER_SIZE];
  ssize_t read_count;
  while ((read_count = read(source_fd, buffer, sizeof(buffer))) > 0) {
    ssize_t written = 0;
    while (written < read_count) {
      ssize_t result = write(destination_fd, buffer + written, (size_t)(read_count - written));
      if (result < 0) return fail_errno("write export temporary");
      written += result;
    }
  }
  if (read_count < 0) return fail_errno("read export source");
  return 0;
}

static int open_relative_directory(int root_fd, char **components, size_t component_count, int *result_fd) {
  int current_fd = dup(root_fd);
  if (current_fd < 0) return fail_errno("duplicate destination directory");

  for (size_t index = 0; index < component_count; index += 1) {
    int next_fd = openat(current_fd, components[index], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next_fd < 0 && errno == ENOENT) {
      if (mkdirat(current_fd, components[index], 0700) < 0 && errno != EEXIST) {
        close(current_fd);
        return fail_errno("create export directory");
      }
      next_fd = openat(current_fd, components[index], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (next_fd < 0) {
      close(current_fd);
      if (errno == ELOOP || errno == ENOTDIR) {
        report_error("export path component is a symbolic-link or not a directory");
        return 1;
      }
      return fail_errno("open export directory");
    }
    struct stat stat_result;
    if (fstat(next_fd, &stat_result) < 0 || !S_ISDIR(stat_result.st_mode)) {
      close(next_fd);
      close(current_fd);
      report_error("export path component is not a directory");
      return 1;
    }
    close(current_fd);
    current_fd = next_fd;
  }
  *result_fd = current_fd;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    report_error("usage: lucifold-export-publisher SOURCE_PATH RELATIVE_DESTINATION EXPECTED_ROOT");
    return 1;
  }

  const int root_fd = 3;
  struct stat root_stat;
  if (fstat(root_fd, &root_stat) < 0) return fail_errno("inspect destination directory");
  if (!S_ISDIR(root_stat.st_mode)) {
    report_error("destination handle is not a directory");
    return 1;
  }

  const char *relative = argv[2];
  const char *expected_root = argv[3];
  if (relative[0] == '\0' || relative[0] == '/' || strstr(relative, "//") != NULL || relative[strlen(relative) - 1] == '/') {
    report_error("unsafe relative export path");
    return 1;
  }
  if (expected_root[0] != '/') {
    report_error("unsafe expected export root");
    return 1;
  }

  char *path_copy = strdup(relative);
  if (!path_copy) return fail_errno("allocate export path");
  char *components[MAX_COMPONENTS];
  size_t component_count = 0;
  char *cursor = NULL;
  char *component = strtok_r(path_copy, "/", &cursor);
  while (component != NULL) {
    if (component_count >= MAX_COMPONENTS || !valid_component(component)) {
      free(path_copy);
      report_error("unsafe relative export path");
      return 1;
    }
    components[component_count++] = component;
    component = strtok_r(NULL, "/", &cursor);
  }
  if (component_count == 0) {
    free(path_copy);
    report_error("unsafe relative export path");
    return 1;
  }

  int destination_fd = root_fd;
  int opened_destination_fd = -1;
  if (component_count > 1) {
    if (open_relative_directory(root_fd, components, component_count - 1, &opened_destination_fd) != 0) {
      free(path_copy);
      return 1;
    }
    destination_fd = opened_destination_fd;
  } else {
    destination_fd = dup(root_fd);
    if (destination_fd < 0) {
      free(path_copy);
      return fail_errno("duplicate destination directory");
    }
  }

  int source_fd = open(argv[1], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source_fd < 0) {
    close(destination_fd);
    free(path_copy);
    return fail_errno("open export source");
  }
  struct stat source_stat;
  if (fstat(source_fd, &source_stat) < 0 || !S_ISREG(source_stat.st_mode)) {
    close(source_fd);
    close(destination_fd);
    free(path_copy);
    report_error("export source is not a regular file");
    return 1;
  }

  char temporary_name[NAME_MAX];
  int temporary_fd = -1;
  for (unsigned int attempt = 0; attempt < 128; attempt += 1) {
    snprintf(temporary_name, sizeof(temporary_name), ".lucifold-export-%ld-%u.tmp", (long)getpid(), attempt);
    temporary_fd = openat(destination_fd, temporary_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (temporary_fd >= 0) break;
    if (errno != EEXIST) {
      close(source_fd);
      close(destination_fd);
      free(path_copy);
      return fail_errno("create export temporary");
    }
  }
  if (temporary_fd < 0) {
    close(source_fd);
    close(destination_fd);
    free(path_copy);
    report_error("could not create a unique export temporary");
    return 1;
  }

  int result = copy_source(source_fd, temporary_fd);
  struct stat source_after;
  if (result == 0 && (fstat(source_fd, &source_after) < 0 || source_after.st_size != source_stat.st_size || source_after.st_ino != source_stat.st_ino || source_after.st_dev != source_stat.st_dev)) {
    report_error("export source changed during publication");
    result = 1;
  }
  if (result == 0 && fsync(temporary_fd) < 0) result = fail_errno("sync export temporary");
  close(source_fd);
  close(temporary_fd);

  if (result == 0) result = validate_directory_containment(root_fd, destination_fd, expected_root);

  bool published = false;
  if (result == 0 && linkat(destination_fd, temporary_name, destination_fd, components[component_count - 1], 0) < 0) {
    if (errno == EEXIST) {
      unlinkat(destination_fd, temporary_name, 0);
      close(destination_fd);
      free(path_copy);
      return COLLISION_EXIT;
    }
    result = fail_errno("publish export");
  } else if (result == 0) {
    published = true;
  }
  if (result == 0) result = validate_directory_containment(root_fd, destination_fd, expected_root);
  if (result == 0 && unlinkat(destination_fd, temporary_name, 0) < 0) result = fail_errno("remove export temporary");
  if (result == 0 && fsync(destination_fd) < 0) result = fail_errno("sync export directory");
  if (result == 0) {
    char published_directory[PATH_MAX];
    if (descriptor_path(destination_fd, published_directory, sizeof(published_directory)) != 0) {
      result = 1;
    } else {
      printf("%s/%s\n", published_directory, components[component_count - 1]);
      fflush(stdout);
    }
  }
  if (result != 0) unlinkat(destination_fd, temporary_name, 0);
  if (result != 0 && published) unlinkat(destination_fd, components[component_count - 1], 0);
  close(destination_fd);
  free(path_copy);
  return result;
}
