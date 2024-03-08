require 'nokogiri'
require 'yaml'
require 'uri'
require 'open-uri'
require 'net/http'

# Check if the original source still exists
def source_exists?(url)
  url = URI.parse(url)
  req = Net::HTTP.new(url.host, url.port)
  req.use_ssl = (url.scheme == 'https')
  res = req.request_head(url.path)
  res.code != "404"  # Assuming that a 404 response code means the source is gone
rescue => e
  puts "Error checking URL #{url}: #{e}"
  false
end

Jekyll::Hooks.register :site, :after_init do |_site, _payload|
  puts "Extracting snapshot metadata..."
  # Define the paths
  html_folder = "snapshots"  # Replace with your actual static files folder if different
  title_yaml_file = "_data/snapshot_titles.yml"  # This is where the YAML file will be saved
  source_yaml_file = "_data/snapshot_sources.yml"

  # Initialize an empty hash to store filenames and titles
  title_hash = {}
  source_hash = {}

  # Loop through each HTML file in the directory
  Dir["#{html_folder}/*.html"].each do |filepath|
    filename = File.basename(filepath)

    # Parse HTML to extract title
    content = File.read(filepath)
    doc = Nokogiri::HTML(content)
    title = doc.at('title') ? doc.at('title').text : 'No Title'

    # source_link = doc.at('.infobar-link-icon') ? doc.at('.infobar-link-icon')['href'] : ''
    # if source_link.empty?
    #   # Extract the URL from the filename
    #   extracted_url = filename.match(/https?__.+?(?=-\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}\.\d{3}Z\.html$)/)
    #   if extracted_url
    #     # Replace underscores with slashes and decode URI component
    #     #source_link = extracted_url[0].gsub('_', '/').gsub('https:/', 'https://').gsub('http:/', 'http://')
    #     #source_link = URI.decode_www_form_component(source_link)
    #     #p extracted_url[0]
    #     deslugified_url = extracted_url[0].gsub('https__','https://').gsub('http__','http://').gsub('_', '/')
    #     deslugified_url = URI.decode_www_form_component(deslugified_url)
    #     source_link = deslugified_url
    #   end
    # end
    # Extract the URL from the saved page comment
    saved_page_comment = doc.at('html').children[0].text.strip
    source_link_match = saved_page_comment.match(/url: (\S+)/)
    source_link = source_link_match[1] unless source_link_match.nil?

    # Too slow to do regularly
    # puts "Checking if source exists for #{filename}: #{source_link}"
    # unless source_link.empty? || source_exists?(source_link)
    #   puts "#{source_link} appears to be gone."
    #   source_link = "gone"
    # end
    source_hash[filename] = source_link

    # Add to hash
    title_hash[filename] = title
  end

  # Write hash to a YAML file
  File.open(title_yaml_file, 'w') { |file| file.write(title_hash.to_yaml) }
  File.open(source_yaml_file, 'w') { |file| file.write(source_hash.to_yaml) }
end
