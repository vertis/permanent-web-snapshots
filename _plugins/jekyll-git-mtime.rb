# module Jekyll
#     module GitMtime
#         class GitError < StandardError; end

#         # run before most other hooks
#         LOW_PRIORITY = Jekyll::Hooks::PRIORITY_MAP[:low]

#         # Various constants
#         MTIME_PAGE_VAR = 'mtime'

#         def self.get_mtime(path=nil)
#             puts path
#             additional_status_options = ''
#             additional_log_options = ''


#             if(path == "feed.xml")
#                 return nil
#             end

#             if (path != nil)
#                 additional_status_options = "--ignored -- #{path}"
#                 additional_log_options = "-- #{path}"
#             end

#             git_status_str = `git status --porcelain -uall #{additional_status_options}`
#             if ($? != 0)
#                 raise GitError, "git status failed"
#             end

#             if (!git_status_str.empty?)
#                 # git status reported that the file or workspace has been modified/ignored/staged/...
#                 return nil
#             else
#                 git_log_cmd =  "git log -1 --format=format:\"%ct\" #{additional_log_options}"
#                 puts git_log_cmd
#                 git_log_str = `#{git_log_cmd}`
#                 if ($? != 0 || git_log_str.empty?)
#                     raise GitError, "git log failed"
#                 end

#                 return Time.at git_log_str.to_i
#             end
#         end

#         Jekyll::Hooks.register(:pages, :post_init, priority: LOW_PRIORITY) do |page|
#             if (page.data[MTIME_PAGE_VAR] == 'build' || page.data[MTIME_PAGE_VAR] == 'site.time')
#                 # mtime has been explicitly set to site.time (time of current build)
#                 page.data[MTIME_PAGE_VAR] = page.site.time
#             elsif (page.data[MTIME_PAGE_VAR] == 'site' || page.data[MTIME_PAGE_VAR] == 'branch')
#                 # set mtime to the time of the latest of any commits (not necessarily related to the current page“
#                 page.data[MTIME_PAGE_VAR] = get_mtime || page.site.time
#             elsif (page.data[MTIME_PAGE_VAR] == nil)
#                 # set mtime to the time of the last commit related to the current page
#                 page.data[MTIME_PAGE_VAR] = get_mtime(page.path) || File.exist?(page.path) ? File.mtime(page.path) : nil
#             end
#         end
#     end
# end