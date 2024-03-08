Jekyll::Hooks.register :site, :post_write do |site|
  puts "Running 'bun build-css' after site generation..."
  system("bun build-css")
end
