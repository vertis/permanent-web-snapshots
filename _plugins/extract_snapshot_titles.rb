require 'nokogiri'
require 'yaml'
Jekyll::Hooks.register :site, :pre_render do |_site, _payload|
  # Define the paths
  html_folder = "snapshots"  # Replace with your actual static files folder if different
  yaml_file = "_data/snapshot_titles.yml"  # This is where the YAML file will be saved

  # Initialize an empty hash to store filenames and titles
  title_hash = {}

  # Loop through each HTML file in the directory
  Dir["#{html_folder}/*.html"].each do |filepath|
    filename = File.basename(filepath)

    # Parse HTML to extract title
    content = File.read(filepath)
    doc = Nokogiri::HTML(content)
    title = doc.at('title') ? doc.at('title').text : 'No Title'

    # Add to hash
    title_hash[filename] = title
  end

  # Write hash to a YAML file
  File.open(yaml_file, 'w') { |file| file.write(title_hash.to_yaml) }
end
